import { parseSync, Visitor } from "oxc-parser";
import type { Candidate, ProjectFile } from "../types.js";
import { belongsDirectlyToFunction, containsNode, nestedFunctionRanges } from "./function-scope.js";
import {
  findDirectFunction,
  findFunctionCallers,
  functionName,
  isFunctionExported,
} from "./repository.js";
import type { FunctionCaller } from "./repository.js";

export type SetOperationKind = "dedupe" | "intersection" | "difference" | null;

export type HandRolledSetOpsEvidence = {
  function: {
    name: string | null;
    exported: boolean;
    filePath: string;
    source: string;
  };
  operation: Exclude<SetOperationKind, null>;
  loopExcerpts: string[];
  membershipChecks: string[];
  comparatorSignals: string[];
  callers: FunctionCaller[];
};

const MEMBERSHIP_PATTERN = /\.indexOf\s*\(|\.includes\s*\(|\.has\s*\(|\.find\s*\(|===\s*-1|!==\s*-1/g;
const COMPARATOR_PATTERN =
  /localeCompare|toLowerCase\s*\(|toUpperCase\s*\(|Math\.abs\s*\(|\bepsilon\b|\btolerance\b|getTime\s*\(|valueOf\s*\(|\.\w*(key|id|hash)\b\s*[)=]/g;

function loopExcerpt(source: string, start: number, end: number): string {
  return source.slice(start, end).slice(0, 200);
}

export function buildHandRolledSetOpsEvidence(
  candidate: Candidate,
  projectFiles: ProjectFile[],
): HandRolledSetOpsEvidence | undefined {
  if (candidate.kind !== "function") return undefined;
  const owner = projectFiles.find((file) => file.filePath === candidate.filePath);
  if (!owner) return undefined;
  const parsed = parseSync(owner.filePath, owner.source, { range: true });
  if (parsed.errors.some((error) => error.severity === "Error")) return undefined;
  const fn = findDirectFunction(parsed.program, candidate);
  if (!fn) return undefined;
  const nested = nestedFunctionRanges(parsed.program, fn);
  const source = owner.source;
  const functionText = source.slice(candidate.start, candidate.end);

  const loopExcerpts: string[] = [];
  let loopDepth = 0;
  new Visitor({
    ForStatement(node) {
      if (!containsNode(fn, node) || !belongsDirectlyToFunction(node, nested)) return;
      loopDepth += 1;
      loopExcerpts.push(loopExcerpt(source, node.start, node.end));
    },
    ForOfStatement(node) {
      if (!containsNode(fn, node) || !belongsDirectlyToFunction(node, nested)) return;
      loopDepth += 1;
      loopExcerpts.push(loopExcerpt(source, node.start, node.end));
    },
    ForInStatement(node) {
      if (!containsNode(fn, node) || !belongsDirectlyToFunction(node, nested)) return;
      loopDepth += 1;
      loopExcerpts.push(loopExcerpt(source, node.start, node.end));
    },
    WhileStatement(node) {
      if (!containsNode(fn, node) || !belongsDirectlyToFunction(node, nested)) return;
      loopDepth += 1;
      loopExcerpts.push(loopExcerpt(source, node.start, node.end));
    },
    CallExpression(call) {
      if (!containsNode(fn, call) || !belongsDirectlyToFunction(call, nested)) return;
      const callee = call.callee.type === "ChainExpression" ? call.callee.expression : call.callee;
      if (
        callee.type === "MemberExpression"
        && callee.property.type === "Identifier"
        && (callee.property.name === "forEach" || callee.property.name === "filter")
      ) {
        loopDepth += 1;
        loopExcerpts.push(loopExcerpt(source, call.start, call.end));
      }
    },
  }).visit(parsed.program);
  if (loopExcerpts.length === 0) return undefined;

  const membershipChecks = [...functionText.matchAll(MEMBERSHIP_PATTERN)]
    .map((match) => match[0].slice(0, 40))
    .slice(0, 10);
  if (membershipChecks.length === 0) return undefined;
  if (!/\.push\s*\(/.test(functionText)) return undefined;

  const negated = /!\s*\w[\w.]*\.(includes|has)\s*\(|===\s*-1|indexOf\s*\([^)]*\)\s*===\s*-1/.test(functionText);
  const pairedInputs = /function\s+\w+\s*\(\s*\w+\s*,\s*\w+/.test(functionText)
    || /\(\s*\w+\s*,\s*\w+\s*\)\s*=>/.test(functionText);
  const pushTargets = new Set(
    [...functionText.matchAll(/(\w+)\.push\s*\(/g)].map((match) => match[1]),
  );
  const negatedRoots = new Set<string>();
  for (const match of functionText.matchAll(/!\s*(\w+)[\w.]*\.(includes|has)\s*\(/g)) {
    if (match[1]) negatedRoots.add(match[1]);
  }
  for (const match of functionText.matchAll(/(\w+)[\w.]*\.indexOf\s*\([^)]*\)\s*===\s*-1/g)) {
    if (match[1]) negatedRoots.add(match[1]);
  }
  const excludesAnotherCollection = [...negatedRoots].some((root) => !pushTargets.has(root));
  const operation: Exclude<SetOperationKind, null> = loopDepth >= 2 || pairedInputs
    ? (negated && excludesAnotherCollection ? "difference" : "intersection")
    : "dedupe";

  const comparatorSignals = [...functionText.matchAll(COMPARATOR_PATTERN)]
    .map((match) => match[0].slice(0, 60))
    .slice(0, 10);

  const name = functionName(parsed.program, fn);
  return {
    function: {
      name: name ?? null,
      exported: name ? isFunctionExported(parsed.program, fn, name) : false,
      filePath: candidate.filePath,
      source: candidate.source,
    },
    operation,
    loopExcerpts: loopExcerpts.slice(0, 5),
    membershipChecks,
    comparatorSignals,
    callers: name ? findFunctionCallers(candidate.filePath, name, projectFiles) : [],
  };
}
