import { parseSync, Visitor } from "oxc-parser";
import type { Candidate, ProjectFile } from "../types.js";
import {
  findFunctionCallers,
  functionName,
  isFunctionExported,
} from "./repository.js";
import type { FunctionCaller, FunctionNode } from "./repository.js";
import { isTestFilePath } from "./test-scope.js";

export type ClaimSignal = {
  signal: string;
  excerpt: string;
};

export type TestPinning = {
  filePath: string;
  excerpt: string;
};

export type UnverifiedClaimEvidence = {
  comment: {
    filePath: string;
    source: string;
    startLine: number;
  };
  claimSignals: ClaimSignal[];
  specificity: "specific" | "vague";
  enclosingFunction: {
    name: string | null;
    exported: boolean;
    source: string;
  } | null;
  callers: FunctionCaller[];
  testPinning: TestPinning[];
  trackedWork: string[];
  tone: {
    hedge: string[];
    reassurance: string[];
  };
};

const CLAIM_PATTERNS: { name: string; pattern: RegExp }[] = [
  { name: "handle-behavior", pattern: /\bhandles?\b/i },
  { name: "retry-behavior", pattern: /\bretr(?:y|ies)\b/i },
  { name: "guarantee", pattern: /\bguarantees?\b/i },
  { name: "ensure-behavior", pattern: /\bensures?\b/i },
  { name: "validate", pattern: /\bvalidates?\b/i },
  { name: "support", pattern: /\bsupports?\b/i },
  { name: "manage", pattern: /\bmanages?\b/i },
  { name: "process-behavior", pattern: /\bprocesses?\b/i },
  { name: "implement", pattern: /\bImplements?\b/i },
  { name: "provide", pattern: /\bprovides?\b/i },
  { name: "perform", pattern: /\bperforms?\b/i },
  { name: "execute-behavior", pattern: /\bexecutes?\b/i },
  { name: "cache-behavior", pattern: /\bcaches?\b/i },
  { name: "parse-behavior", pattern: /\bparses?\b/i },
  { name: "normalize", pattern: /\bnormali[sz]es?\b/i },
  { name: "split-behavior", pattern: /\bsplits?\b/i },
  { name: "convert", pattern: /\bconverts?\b/i },
  { name: "compute", pattern: /\bcomputes?\b/i },
  { name: "derive", pattern: /\bderives?\b/i },
  { name: "resolve-behavior", pattern: /\bresolves?\b/i },
  { name: "recover", pattern: /\brecovers?\b/i },
  { name: "fallback", pattern: /\bfalls?\s+back\b/i },
  { name: "backoff", pattern: /\bbackoff\b/i },
  { name: "edge-cases", pattern: /\bedge\s+cases?\b/i },
  { name: "transient", pattern: /\btransient\b/i },
  { name: "return-behavior", pattern: /\breturns?\b/i },
];

const VAGUE_PATTERNS: RegExp[] = [
  /\bgracefully\b/i,
  /\brobust(ly)?\b/i,
  /\bseamlessly\b/i,
  /\btransparently\b/i,
  /\bproperly\b/i,
  /\bcorrectly\b/i,
  /\bmost\s+cases\b/i,
  /\ball\s+edge\s+cases\b/i,
  /\bany\s+(unexpected|unforeseen)\b/i,
  /\bunexpected\s+states\b/i,
  /\bshould\s+(work|handle|be\s+fine)\b/i,
];

const DEFERRED_WORK_PATTERN = /\bTODO\b|\bFIXME\b|\bHACK\b|\bXXX\b|\bTBD\b|@todo/i;

const TRACKED_WORK_PATTERNS: RegExp[] = [
  /#\d+/,
  /\b[A-Z]{2,10}-\d+\b/,
  /https?:\/\/\S+/i,
];

const HEDGE_PATTERNS: RegExp[] = [
  /\bshould\b/i,
  /\bprobably\b/i,
  /\bhopefully\b/i,
  /\bseems?\s+to\b/i,
  /\bmight\b/i,
  /\bjust\s+in\s+case\b/i,
  /\bnot\s+sure\b/i,
  /\blikely\b/i,
  /\bpresumably\b/i,
  /\bpossibly\b/i,
  /\bappears?\s+to\b/i,
];

const REASSURANCE_PATTERNS: RegExp[] = [
  /\bgracefully\b/i,
  /\brobust(ly)?\b/i,
  /\brest\s+assured\b/i,
  /\bno\s+need\s+to\s+worry\b/i,
  /\bsimply\s+works?\b/i,
  /\bworks?\s+(fine|as\s+expected)\b/i,
  /\bdoes\s+the\s+right\s+thing\b/i,
  /\btakes?\s+care\s+of\b/i,
];

function claimSignals(text: string): ClaimSignal[] {
  return CLAIM_PATTERNS.flatMap(({ name, pattern }) => {
    const match = pattern.exec(text);
    return match ? [{ signal: name, excerpt: match[0].slice(0, 200) }] : [];
  });
}

function toneMatches(patterns: RegExp[], text: string): string[] {
  const found: string[] = [];
  for (const pattern of patterns) {
    const match = pattern.exec(text);
    if (match) found.push(match[0].slice(0, 200));
  }
  return found.slice(0, 10);
}

function trackedWork(text: string): string[] {
  const found: string[] = [];
  for (const pattern of TRACKED_WORK_PATTERNS) {
    const match = pattern.exec(text);
    if (match) found.push(match[0].slice(0, 300));
  }
  return found;
}

function enclosingFunction(
  program: Parameters<Visitor["visit"]>[0],
  candidate: Candidate,
): FunctionNode | undefined {
  const functions: FunctionNode[] = [];
  const collect = (node: FunctionNode): void => {
    if (node.start === candidate.start && node.end === candidate.end) return;
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

function testPinning(
  name: string,
  ownerPath: string,
  projectFiles: ProjectFile[],
): TestPinning[] {
  const reference = new RegExp(`\\b${name.replaceAll(/[^A-Za-z0-9_$]/g, "")}\\b`);
  const pinned: TestPinning[] = [];
  for (const file of projectFiles) {
    if (file.filePath === ownerPath) continue;
    if (!isTestFilePath(file.filePath)) continue;
    for (const line of file.source.split("\n")) {
      if (!reference.test(line)) continue;
      pinned.push({ filePath: file.filePath, excerpt: line.trim().slice(0, 300) });
      if (pinned.length >= 5) return pinned;
    }
  }
  return pinned;
}

export function buildUnverifiedClaimEvidence(
  candidate: Candidate,
  projectFiles: ProjectFile[],
): UnverifiedClaimEvidence | undefined {
  if (candidate.kind !== "comment") return undefined;
  const ownerFile = projectFiles.find((file) => file.filePath === candidate.filePath);
  if (!ownerFile) return undefined;
  const parsed = parseSync(ownerFile.filePath, ownerFile.source, { range: true });
  if (parsed.errors.some((error) => error.severity === "Error")) return undefined;

  const signals = claimSignals(candidate.source);
  if (signals.length === 0) return undefined;
  if (DEFERRED_WORK_PATTERN.test(candidate.source)) return undefined;

  const fn = enclosingFunction(parsed.program, candidate);
  const name = fn ? functionName(parsed.program, fn) : undefined;
  return {
    comment: {
      filePath: candidate.filePath,
      source: candidate.source,
      startLine: candidate.startLine,
    },
    claimSignals: signals,
    specificity: VAGUE_PATTERNS.some((pattern) => pattern.test(candidate.source))
      ? "vague"
      : "specific",
    enclosingFunction: fn
      ? {
        name: name ?? null,
        exported: name ? isFunctionExported(parsed.program, fn, name) : false,
        source: ownerFile.source.slice(fn.start, fn.end).slice(0, 4000),
      }
      : null,
    callers: name ? findFunctionCallers(candidate.filePath, name, projectFiles) : [],
    testPinning: name ? testPinning(name, candidate.filePath, projectFiles) : [],
    trackedWork: trackedWork(candidate.source),
    tone: {
      hedge: toneMatches(HEDGE_PATTERNS, candidate.source),
      reassurance: toneMatches(REASSURANCE_PATTERNS, candidate.source),
    },
  };
}
