import { Visitor } from "oxc-parser";
import { parseCached } from "./parse-cache.js";
import type { Candidate, ProjectFile } from "../types.js";
import { belongsDirectlyToFunction, nestedFunctionRanges } from "./function-scope.js";
import {
  findDirectFunction,
  findFunctionCallers,
  functionName,
  isFunctionExported,
} from "./repository.js";
import type { FunctionCaller } from "./repository.js";

export type NestingReturn = {
  line: number;
  depth: number;
  early: boolean;
};

export type DeepHappyPathNestingEvidence = {
  function: {
    name: string;
    exported: boolean;
    filePath: string;
    source: string;
  };
  maxReturnDepth: number;
  maxBlockDepth: number;
  returns: NestingReturn[];
  earlyReturnCount: number;
  elseChainCount: number;
  hasSwitchDispatch: boolean;
  callers: FunctionCaller[];
};

function lineAt(source: string, offset: number): number {
  let line = 1;
  for (let index = 0; index < offset; index += 1) {
    if (source[index] === "\n") line += 1;
  }
  return line;
}

export function buildDeepHappyPathNestingEvidence(
  candidate: Candidate,
  projectFiles: ProjectFile[],
): DeepHappyPathNestingEvidence | undefined {
  if (candidate.kind !== "function") return undefined;
  const owner = projectFiles.find((file) => file.filePath === candidate.filePath);
  if (!owner) return undefined;
  const parsed = parseCached(owner.filePath, owner.source);
  if (parsed.errors.some((error) => error.severity === "Error")) return undefined;
  const fn = findDirectFunction(parsed.program, candidate);
  if (!fn) return undefined;
  const name = functionName(parsed.program, fn);
  if (!name) return undefined;

  const nested = nestedFunctionRanges(parsed.program, fn);
  const inScope = (start: number, end: number): boolean =>
    start >= candidate.start && end <= candidate.end
    && belongsDirectlyToFunction({ start, end }, nested);

  let depth = 0;
  let maxBlockDepth = 0;
  let elseChainCount = 0;
  let hasSwitchDispatch = false;
  const returns: Array<NestingReturn & { offset: number }> = [];

  const enter = (): void => {
    depth += 1;
    if (depth > maxBlockDepth) maxBlockDepth = depth;
  };
  const exit = (): void => {
    depth -= 1;
  };

  new Visitor({
    IfStatement(node) {
      if (!inScope(node.start, node.end)) return;
      if (node.alternate?.type === "IfStatement") elseChainCount += 1;
      enter();
    },
    "IfStatement:exit"(node) {
      if (!inScope(node.start, node.end)) return;
      exit();
    },
    ForStatement(node) {
      if (!inScope(node.start, node.end)) return;
      enter();
    },
    "ForStatement:exit"(node) {
      if (!inScope(node.start, node.end)) return;
      exit();
    },
    ForInStatement(node) {
      if (!inScope(node.start, node.end)) return;
      enter();
    },
    "ForInStatement:exit"(node) {
      if (!inScope(node.start, node.end)) return;
      exit();
    },
    ForOfStatement(node) {
      if (!inScope(node.start, node.end)) return;
      enter();
    },
    "ForOfStatement:exit"(node) {
      if (!inScope(node.start, node.end)) return;
      exit();
    },
    WhileStatement(node) {
      if (!inScope(node.start, node.end)) return;
      enter();
    },
    "WhileStatement:exit"(node) {
      if (!inScope(node.start, node.end)) return;
      exit();
    },
    DoWhileStatement(node) {
      if (!inScope(node.start, node.end)) return;
      enter();
    },
    "DoWhileStatement:exit"(node) {
      if (!inScope(node.start, node.end)) return;
      exit();
    },
    SwitchStatement(node) {
      if (!inScope(node.start, node.end)) return;
      hasSwitchDispatch = true;
      enter();
    },
    "SwitchStatement:exit"(node) {
      if (!inScope(node.start, node.end)) return;
      exit();
    },
    TryStatement(node) {
      if (!inScope(node.start, node.end)) return;
      enter();
    },
    "TryStatement:exit"(node) {
      if (!inScope(node.start, node.end)) return;
      exit();
    },
    CatchClause(node) {
      if (!inScope(node.start, node.end)) return;
      enter();
    },
    "CatchClause:exit"(node) {
      if (!inScope(node.start, node.end)) return;
      exit();
    },
    ReturnStatement(node) {
      if (!inScope(node.start, node.end)) return;
      returns.push({
        line: lineAt(owner.source, node.start),
        depth,
        early: depth <= 1,
        offset: node.start,
      });
    },
  }).visit(parsed.program);

  if (returns.length === 0) return undefined;
  const maxReturnDepth = Math.max(...returns.map((entry) => entry.depth));
  if (maxReturnDepth < 3) return undefined;

  returns.sort((left, right) => left.offset - right.offset);
  const earlyReturnCount = returns.filter((entry) => entry.early).length;

  return {
    function: {
      name,
      exported: isFunctionExported(parsed.program, fn, name),
      filePath: candidate.filePath,
      source: candidate.source,
    },
    maxReturnDepth,
    maxBlockDepth,
    returns: returns.map(({ line, depth: returnDepth, early }) => ({ line, depth: returnDepth, early })),
    earlyReturnCount,
    elseChainCount,
    hasSwitchDispatch,
    callers: findFunctionCallers(candidate.filePath, name, projectFiles),
  };
}
