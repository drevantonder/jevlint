import { Visitor } from "oxc-parser";
import { parseCached } from "./parse-cache.js";
import type { Candidate, ProjectFile } from "../types.js";
import type { FunctionNode } from "./repository.js";

export type UnexplainedSuppressionEvidence = {
  comment: {
    filePath: string;
    source: string;
    startLine: number;
  };
  directive: string;
  suppressedRules: string[];
  ruleFamily: "type-safety" | "safety" | "other";
  scope: "line" | "file";
  rationaleWords: number;
  adjoiningCode: string;
  riskSignals: string[];
};

const SUPPRESSION_PATTERNS: { name: string; pattern: RegExp }[] = [
  { name: "eslint-disable", pattern: /eslint-disable(?:-next-line|-line)?/i },
  { name: "oxlint-disable", pattern: /oxlint-disable(?:-next-line|-line)?/i },
  { name: "ts-expect-error", pattern: /@ts-expect-error/i },
  { name: "ts-ignore", pattern: /@ts-ignore/i },
  { name: "ts-nocheck", pattern: /@ts-nocheck/i },
  { name: "deno-lint-ignore", pattern: /deno-lint-ignore/i },
];

const LINE_SCOPED_MARKERS: RegExp[] = [
  /eslint-disable-(next-line|line)/i,
  /oxlint-disable-(next-line|line)/i,
  /@ts-expect-error/i,
  /@ts-ignore/i,
  /deno-lint-ignore/i,
];

const RATIONALE_PATTERNS: RegExp[] = [
  /\bbecause\b/i,
  /#\d+/,
  /\b[A-Z]{2,10}-\d+\b/,
  /https?:\/\/\S+/i,
  /--\s+\S+/,
];

const SAFETY_RULE_PATTERN = /typescript|ts-|unsafe|secur|no-explicit-any|no-non-null|ban-ts|no-floating-promises|no-misused/i;

const RISKY_SIGNALS: { name: string; pattern: RegExp }[] = [
  { name: "cast", pattern: /\bas\s+(?:const\b|[{A-Za-z_$(])/ },
  { name: "explicit-any", pattern: /:\s*any\b/ },
  { name: "non-null-assertion", pattern: /!\s*[).;,]/ },
  { name: "dynamic-access", pattern: /\[[A-Za-z_$][\w$]*\]/ },
  { name: "delete-operator", pattern: /\bdelete\s+[A-Za-z_$]/ },
];

function adjoiningFunction(
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

function suppressedRules(text: string, directiveEnd: number): string[] {
  const rest = text.slice(directiveEnd).split("\n")[0] ?? "";
  const cleaned = rest.replace(/^[\s:,-]*/, "").split(/--/)[0] ?? "";
  return cleaned
    .split(",")
    .map((part) => part.trim().replace(/^[/*\s]+/, ""))
    .filter((part) => part.length > 0 && !/^because\b/i.test(part))
    .map((part) => part.slice(0, 120))
    .slice(0, 5);
}

function rationaleWords(text: string, directiveEnd: number): number {
  const rest = text.slice(directiveEnd).split("\n")[0] ?? "";
  const withoutRules = rest
    .replace(/^[/*\s:,-]*/, "")
    .replace(/[\w@/-]+(?:,\s*[\w@/-]+)*/, "")
    .replace(/--/, " ");
  return withoutRules.split(/\s+/).filter((word) => /[A-Za-z]/.test(word)).length;
}

export function buildUnexplainedSuppressionEvidence(
  candidate: Candidate,
  projectFiles: ProjectFile[],
): UnexplainedSuppressionEvidence | undefined {
  if (candidate.kind !== "comment") return undefined;
  const ownerFile = projectFiles.find((file) => file.filePath === candidate.filePath);
  if (!ownerFile) return undefined;
  const parsed = parseCached(ownerFile.filePath, ownerFile.source);
  if (parsed.errors.some((error) => error.severity === "Error")) return undefined;

  const text = candidate.source;
  const hit = SUPPRESSION_PATTERNS.flatMap(({ name, pattern }) => {
    const match = pattern.exec(text);
    return match && match.index !== undefined
      ? [{ directive: name, index: match.index, length: match[0].length }]
      : [];
  }).sort((left, right) => left.index - right.index)[0];
  if (!hit) return undefined;
  if (RATIONALE_PATTERNS.some((pattern) => pattern.test(text))) return undefined;

  const rules = suppressedRules(text, hit.index + hit.length);
  const joined = rules.join(" ");
  const ruleFamily: UnexplainedSuppressionEvidence["ruleFamily"] = SAFETY_RULE_PATTERN.test(joined)
    || hit.directive === "ts-expect-error"
    || hit.directive === "ts-ignore"
    || hit.directive === "ts-nocheck"
    ? "type-safety"
    : /secur|unsafe/i.test(joined)
      ? "safety"
      : "other";

  const fn = adjoiningFunction(parsed.program, candidate);
  const adjoiningCode = fn
    ? ownerFile.source.slice(fn.start, fn.end).slice(0, 2000)
    : ownerFile.source.split("\n").slice(candidate.startLine, candidate.startLine + 5).join("\n");
  const riskSignals = RISKY_SIGNALS.flatMap(({ name, pattern }) =>
    pattern.test(adjoiningCode) ? [name] : []
  );

  return {
    comment: {
      filePath: candidate.filePath,
      source: candidate.source,
      startLine: candidate.startLine,
    },
    directive: hit.directive,
    suppressedRules: rules,
    ruleFamily,
    scope: LINE_SCOPED_MARKERS.some((pattern) => pattern.test(text)) ? "line" : "file",
    rationaleWords: rationaleWords(text, hit.index + hit.length),
    adjoiningCode,
    riskSignals,
  };
}
