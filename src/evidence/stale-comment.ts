import { parseSync, Visitor } from "oxc-parser";
import type { Candidate, ProjectFile, SourceFile } from "../types.js";
import { functionName, isFunctionExported } from "./repository.js";
import type { FunctionNode } from "./repository.js";

export type BehaviorClaim = {
  kind: "count" | "outcome" | "error-path";
  excerpt: string;
};

export type CodeSignals = {
  hasLoop: boolean;
  hasRetryLoop: boolean;
  hasThrow: boolean;
  thrownKinds: string[];
  returnValues: string[];
};

export type ClaimContradiction = {
  claim: string;
  codeFact: string;
};

export type StaleCommentEvidence = {
  comment: {
    filePath: string;
    source: string;
    startLine: number;
  };
  claims: BehaviorClaim[];
  adjoiningCode: {
    functionName: string | null;
    exported: boolean;
    signals: CodeSignals;
  } | null;
  contradictions: ClaimContradiction[];
  changedSide: "comment" | "code" | "both" | "unknown";
};

const COUNT_PATTERN = /\b(\d+)\s*(?:retr(?:y|ies)|attempts?|times?)\b|\bretr(?:y|ies)\s*(?:up\s*to\s*)?(\d+)\s*times?\b/i;
const RETRY_WORD_PATTERN = /\bretr(?:y|ies)\b/i;
const OUTCOME_PATTERN = /\breturns?\s+(null|undefined|empty|nothing|void|an?\s+[\w$]+(?:\s+[\w$]+)?)/i;
const THROWS_PATTERN = /\bthrows?\b/i;
const NEVER_THROWS_PATTERN = /\bnever\s+throws?\b|\bdoes\s+not\s+throw\b|\bno\s+errors?\s+thrown\b/i;
const NO_RETRY_PATTERN = /\bno\s+retr(?:y|ies)\b|\bdoes\s+not\s+retr(?:y|ies)\b|\bwithout\s+retr(?:y|ies)\b/i;

const RETRY_IDENTIFIER_PATTERN = /\bretry\b|\battempt\b|\bbackoff\b/i;

function behaviorClaims(text: string): BehaviorClaim[] {
  const claims: BehaviorClaim[] = [];
  const count = COUNT_PATTERN.exec(text);
  if (count) claims.push({ kind: "count", excerpt: count[0].slice(0, 200) });
  else if (RETRY_WORD_PATTERN.test(text) || NO_RETRY_PATTERN.test(text)) {
    const match = (RETRY_WORD_PATTERN.exec(text) ?? NO_RETRY_PATTERN.exec(text))!;
    claims.push({ kind: "count", excerpt: match[0].slice(0, 200) });
  }
  const outcome = OUTCOME_PATTERN.exec(text);
  if (outcome) claims.push({ kind: "outcome", excerpt: outcome[0].slice(0, 200) });
  const errorPath = NEVER_THROWS_PATTERN.exec(text) ?? THROWS_PATTERN.exec(text);
  if (errorPath) claims.push({ kind: "error-path", excerpt: errorPath[0].slice(0, 200) });
  return claims;
}

function adjoiningFunction(
  program: Parameters<Visitor["visit"]>[0],
  candidate: Candidate,
): FunctionNode | undefined {
  const functions: FunctionNode[] = [];
  const collect = (node: FunctionNode): void => {
    functions.push(node);
  };
  new Visitor({
    ArrowFunctionExpression: collect,
    FunctionDeclaration: collect,
    FunctionExpression: collect,
  }).visit(program);
  const containers = functions.filter((node) =>
    node.start <= candidate.start && node.end >= candidate.end
  );
  if (containers.length > 0) {
    containers.sort((left, right) => (right.start - left.start) || (right.end - left.end));
    return containers[0];
  }
  const following = functions
    .filter((node) => node.start >= candidate.end)
    .sort((left, right) => left.start - right.start);
  return following[0];
}

function codeSignals(source: string, fn: FunctionNode): CodeSignals {
  const body = source.slice(fn.start, fn.end);
  const hasLoop = /\bfor\s*\(|\bwhile\s*\(|\bdo\s*\{/.test(body);
  const hasRetryLoop = hasLoop && RETRY_IDENTIFIER_PATTERN.test(body);
  const thrownKinds: string[] = [];
  const throwMatches = body.matchAll(/throw\s+(?:new\s+)?([A-Za-z_$][\w$]*)/g);
  for (const match of throwMatches) {
    if (match[1] && !thrownKinds.includes(match[1])) thrownKinds.push(match[1]);
  }
  const returnValues: string[] = [];
  const returnMatches = body.matchAll(/return\s*([^;}\n]*)/g);
  for (const match of returnMatches) {
    const form = (match[1] ?? "").trim().slice(0, 60);
    if (form && !returnValues.includes(form)) returnValues.push(form);
  }
  return {
    hasLoop,
    hasRetryLoop,
    hasThrow: thrownKinds.length > 0,
    thrownKinds: thrownKinds.slice(0, 10),
    returnValues: returnValues.slice(0, 10),
  };
}

function contradictions(text: string, signals: CodeSignals): ClaimContradiction[] {
  const result: ClaimContradiction[] = [];
  const count = COUNT_PATTERN.exec(text);
  if (count && !signals.hasRetryLoop) {
    result.push({
      claim: count[0].slice(0, 200),
      codeFact: "adjoining code contains no retry loop",
    });
  }
  if (RETRY_WORD_PATTERN.test(text) && !NO_RETRY_PATTERN.test(text) && !count && !signals.hasRetryLoop) {
    result.push({
      claim: "comment describes retries",
      codeFact: "adjoining code contains no retry loop",
    });
  }
  if (NO_RETRY_PATTERN.test(text) && signals.hasRetryLoop) {
    result.push({
      claim: "comment disclaims retries",
      codeFact: "adjoining code contains a retry loop",
    });
  }
  const outcome = OUTCOME_PATTERN.exec(text);
  if (outcome) {
    const described = outcome[1]?.toLowerCase() ?? "";
    if (signals.returnValues.length === 0 && !/^(nothing|void)\b/.test(described)) {
      result.push({
        claim: outcome[0].slice(0, 200),
        codeFact: "adjoining code has no return of a value",
      });
    } else {
      const matchesDescribed = signals.returnValues.some((returned) => {
        const normalized = returned.toLowerCase();
        if (/^null\b/.test(described)) return normalized.startsWith("null");
        if (/^undefined\b/.test(described)) return normalized.startsWith("undefined");
        if (/^empty\b/.test(described)) {
          return normalized === "[]" || normalized === "{}" || normalized === "\"\"" || normalized === "''";
        }
        return normalized.includes(described.split(/\s+/)[0] ?? "");
      });
      if (!matchesDescribed && signals.returnValues.length > 0) {
        result.push({
          claim: outcome[0].slice(0, 200),
          codeFact: `adjoining returns are: ${signals.returnValues.slice(0, 3).join("; ")}`,
        });
      }
    }
  }
  if (NEVER_THROWS_PATTERN.test(text) && signals.hasThrow) {
    result.push({
      claim: "comment claims no throw",
      codeFact: `adjoining code throws: ${signals.thrownKinds.slice(0, 3).join(", ")}`,
    });
  } else if (THROWS_PATTERN.test(text) && !NEVER_THROWS_PATTERN.test(text) && !signals.hasThrow) {
    result.push({
      claim: "comment describes a throw",
      codeFact: "adjoining code contains no throw",
    });
  }
  return result;
}

function changedSide(
  candidate: Candidate,
  owner: ProjectFile,
  changes: SourceFile[],
): StaleCommentEvidence["changedSide"] {
  const change = changes.find((file) => file.filePath === candidate.filePath);
  if (!change || change.changedLines.length === 0) return "unknown";
  const commentChanged = change.changedLines.some((range) =>
    candidate.startLine <= range.end && candidate.endLine >= range.start
  );
  const ownerLines = owner.source.split("\n").length;
  const codeChanged = change.changedLines.some((range) =>
    range.start <= ownerLines && (range.start < candidate.startLine || range.end > candidate.endLine)
  );
  if (commentChanged && codeChanged) return "both";
  if (commentChanged) return "comment";
  if (codeChanged) return "code";
  return "unknown";
}

export function buildStaleCommentEvidence(
  candidate: Candidate,
  projectFiles: ProjectFile[],
  changes: SourceFile[] = [],
): StaleCommentEvidence | undefined {
  if (candidate.kind !== "comment") return undefined;
  const owner = projectFiles.find((file) => file.filePath === candidate.filePath);
  if (!owner) return undefined;
  const parsed = parseSync(owner.filePath, owner.source, { range: true });
  if (parsed.errors.some((error) => error.severity === "Error")) return undefined;

  const claims = behaviorClaims(candidate.source);
  if (claims.length === 0) return undefined;

  const fn = adjoiningFunction(parsed.program, candidate);
  const name = fn ? functionName(parsed.program, fn) : undefined;
  const signals = fn ? codeSignals(owner.source, fn) : null;
  return {
    comment: {
      filePath: candidate.filePath,
      source: candidate.source,
      startLine: candidate.startLine,
    },
    claims,
    adjoiningCode: fn && signals
      ? {
        functionName: name ?? null,
        exported: name ? isFunctionExported(parsed.program, fn, name) : false,
        signals,
      }
      : null,
    contradictions: signals ? contradictions(candidate.source, signals) : [],
    changedSide: changedSide(candidate, owner, changes),
  };
}
