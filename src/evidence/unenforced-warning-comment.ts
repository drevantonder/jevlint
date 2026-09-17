import { parseSync, Visitor } from "oxc-parser";
import type { Node } from "oxc-parser";
import type { Candidate, ProjectFile } from "../types.js";
import {
  belongsDirectlyToFunction,
  containsNode,
  nestedFunctionRanges,
} from "./function-scope.js";
import type { NodeRange } from "./function-scope.js";
import {
  findFunctionCallers,
  functionName,
  isFunctionExported,
} from "./repository.js";
import type { FunctionCaller, FunctionNode } from "./repository.js";

type HazardMatch = {
  pattern: string;
  excerpt: string;
};

export type UnenforcedWarningCommentEvidence = {
  comment: {
    filePath: string;
    source: string;
    startLine: number;
  };
  hazardMatches: HazardMatch[];
  enclosingFunction: {
    name: string | null;
    exported: boolean;
    source: string;
  };
  guards: string[];
  callers: FunctionCaller[];
};

const HAZARD_PATTERNS: { name: string; pattern: RegExp }[] = [
  { name: "must-call-first", pattern: /must\s+call\s+\S+\s+first/i },
  { name: "must-be-called", pattern: /must\s+be\s+called/i },
  { name: "call-before", pattern: /call\s+\S+\s+before/i },
  { name: "only-valid-after", pattern: /only\s+valid\s+after/i },
  { name: "do-not-call-unless", pattern: /do\s+not\s+call\s+unless/i },
  { name: "only-call-when", pattern: /only\s+call\s+(when|if|after)/i },
  { name: "ensure-before", pattern: /ensure\s+.+\s+(before|first|called)/i },
  { name: "assumes", pattern: /\bassumes?\b/i },
  { name: "not-safe-for", pattern: /not\s+safe\s+for/i },
  { name: "not-thread-safe", pattern: /not\s+thread-?safe/i },
  { name: "not-reentrant", pattern: /not\s+re-?entrant/i },
  { name: "caller-must", pattern: /caller\s+must/i },
  { name: "requires-before", pattern: /requires?\s+.+\s+(before|first)/i },
  { name: "make-sure-before", pattern: /make\s+sure\s+.+\s+(before|first)/i },
];

function nodeSource(node: Node, source: string): string {
  return source.slice(node.start, node.end);
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

function hazardMatches(text: string): HazardMatch[] {
  return HAZARD_PATTERNS.flatMap(({ name, pattern }) => {
    const match = pattern.exec(text);
    return match ? [{ pattern: name, excerpt: match[0] }] : [];
  });
}

export function buildUnenforcedWarningCommentEvidence(
  candidate: Candidate,
  projectFiles: ProjectFile[],
): UnenforcedWarningCommentEvidence | undefined {
  if (candidate.kind !== "comment") return undefined;
  const ownerFile = projectFiles.find((file) => file.filePath === candidate.filePath);
  if (!ownerFile) return undefined;
  const parsed = parseSync(ownerFile.filePath, ownerFile.source, { range: true });
  if (parsed.errors.some((error) => error.severity === "Error")) return undefined;

  const matches = hazardMatches(candidate.source);
  if (matches.length === 0) return undefined;

  const fn = enclosingFunction(parsed.program, candidate);
  if (!fn) return undefined;

  const nested: NodeRange[] = nestedFunctionRanges(parsed.program, fn);
  const guards: string[] = [];
  const inScope = (node: NodeRange): boolean =>
    containsNode(fn, node) && belongsDirectlyToFunction(node, nested);
  new Visitor({
    IfStatement(node) {
      if (!inScope(node)) return;
      guards.push(nodeSource(node, ownerFile.source));
    },
    CallExpression(node) {
      if (!inScope(node)) return;
      const callee = nodeSource(node.callee, ownerFile.source);
      if (!/^(assert|invariant|ensure|check)([.(]|$)/.test(callee)) return;
      guards.push(nodeSource(node, ownerFile.source));
    },
  }).visit(parsed.program);

  const name = functionName(parsed.program, fn);
  return {
    comment: {
      filePath: candidate.filePath,
      source: candidate.source,
      startLine: candidate.startLine,
    },
    hazardMatches: matches,
    enclosingFunction: {
      name: name ?? null,
      exported: name ? isFunctionExported(parsed.program, fn, name) : false,
      source: ownerFile.source.slice(fn.start, fn.end),
    },
    guards,
    callers: name ? findFunctionCallers(candidate.filePath, name, projectFiles) : [],
  };
}
