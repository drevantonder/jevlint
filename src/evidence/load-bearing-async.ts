import { Visitor } from "oxc-parser";
import { parseCached } from "./parse-cache.js";
import type { Expression, Node, Program } from "oxc-parser";
import type { Candidate, ProjectFile } from "../types.js";
import {
  findDirectFunction,
  findFunctionCallers,
  findNamedFunction,
  functionName,
  isFunctionExported,
  isInsideNestedFunction,
  moduleImports,
  nestedFunctionRanges,
  resolveModule,
} from "./repository.js";
import type { FunctionCaller } from "./repository.js";

export type LoadBearingAsyncEvidence = {
  function: {
    name: string;
    exported: boolean;
    filePath: string;
    source: string;
  };
  awaitingBranches: string[];
  callerUsage: {
    awaitingCallSites: string[];
    thenChains: string[];
    promiseCombinators: string[];
    plainCallSites: string[];
  };
  callers: FunctionCaller[];
};

const THENABLE_RETURN_PATTERN = /\.then\s*\(|\.catch\s*\(|\.finally\s*\(|Promise\s*\.(all|allSettled|race|resolve|reject)\s*\(|new\s+Promise\s*\(/;
const THEN_CHAIN_PATTERN = /\.then\s*\(|\.catch\s*\(|\.finally\s*\(/;
const COMBINATOR_PATTERN = /Promise\s*\.(all|allSettled)\s*\(/;

function containsCallTo(source: string, name: string): boolean {
  return new RegExp(`\\b${name}\\s*\\(`).test(source);
}

const AWAITING_BRANCH_LIMIT = 10;
const AWAITING_BRANCH_SLICE_LIMIT = 200;

function unwrapBranchValue(expression: Expression): Expression {
  let current = expression;
  while (
    current.type === "ParenthesizedExpression"
    || current.type === "TSAsExpression"
    || current.type === "TSNonNullExpression"
    || current.type === "TSSatisfiesExpression"
    || current.type === "TSTypeAssertion"
  ) current = current.expression;
  return current;
}

function branchAlternatives(expression: Expression): Expression[] {
  const unwrapped = unwrapBranchValue(expression);
  if (unwrapped.type === "ConditionalExpression") {
    return [...branchAlternatives(unwrapped.consequent), ...branchAlternatives(unwrapped.alternate)];
  }
  if (unwrapped.type === "LogicalExpression") {
    return [...branchAlternatives(unwrapped.left), ...branchAlternatives(unwrapped.right)];
  }
  if (unwrapped.type === "SequenceExpression") {
    const last = unwrapped.expressions[unwrapped.expressions.length - 1];
    return last === undefined ? [unwrapped] : branchAlternatives(last);
  }
  return [unwrapped];
}

function collectAsyncFunctionNames(program: Program): Set<string> {
  const names = new Set<string>();
  new Visitor({
    FunctionDeclaration(node) {
      if (node.async && node.id) names.add(node.id.name);
    },
    VariableDeclarator(node) {
      if (node.id.type !== "Identifier") return;
      if (
        (node.init?.type === "ArrowFunctionExpression" || node.init?.type === "FunctionExpression")
        && node.init.async
      ) names.add(node.id.name);
    },
  }).visit(program);
  return names;
}

// A return branch earns the async marker without an await keyword when it
// hands a project-local async call's promise outward while sibling branches
// return sync values: the marker unifies both shapes behind one signature.
// Only calls that resolve to an async declaration in the project count;
// unresolved or non-async callees never qualify.
export function buildLoadBearingAsyncEvidence(
  candidate: Candidate,
  projectFiles: ProjectFile[],
): LoadBearingAsyncEvidence | undefined {
  if (candidate.kind !== "function") return undefined;
  const owner = projectFiles.find((file) => file.filePath === candidate.filePath);
  if (!owner) return undefined;
  const parsed = parseCached(owner.filePath, owner.source);
  if (parsed.errors.some((error) => error.severity === "Error")) return undefined;
  const fn = findDirectFunction(parsed.program, candidate);
  if (!fn) return undefined;
  if (!fn.async) return undefined;
  const name = functionName(parsed.program, fn);
  if (!name) return undefined;

  const nestedFunctions = nestedFunctionRanges(parsed.program, candidate);
  const inScope = (node: Node): boolean =>
    node.start >= candidate.start
    && node.end <= candidate.end
    && !isInsideNestedFunction(node, nestedFunctions);

  let hasAwait = false;
  let hasThenableReturn = false;
  new Visitor({
    AwaitExpression(node) {
      if (inScope(node)) hasAwait = true;
    },
    ReturnStatement(node) {
      if (!inScope(node) || !node.argument) return;
      if (THENABLE_RETURN_PATTERN.test(owner.source.slice(node.argument.start, node.argument.end))) {
        hasThenableReturn = true;
      }
    },
  }).visit(parsed.program);
  if (hasAwait || hasThenableReturn) return undefined;

  const asyncNames = collectAsyncFunctionNames(parsed.program);
  for (const imported of moduleImports(parsed.program)) {
    const resolved = resolveModule(candidate.filePath, imported.source, projectFiles);
    if (!resolved || resolved.filePath === candidate.filePath) continue;
    const resolvedParsed = parseCached(resolved.filePath, resolved.source);
    if (resolvedParsed.errors.some((error) => error.severity === "Error")) continue;
    if (findNamedFunction(resolvedParsed.program, imported.imported)?.async) {
      asyncNames.add(imported.local);
    }
  }
  const awaitingBranches: string[] = [];
  const recordBranch = (expression: Expression): void => {
    for (const alternative of branchAlternatives(expression)) {
      if (alternative.type !== "CallExpression" || alternative.callee.type !== "Identifier") continue;
      if (!asyncNames.has(alternative.callee.name)) continue;
      if (awaitingBranches.length >= AWAITING_BRANCH_LIMIT) return;
      const slice = owner.source.slice(alternative.start, alternative.end).slice(0, AWAITING_BRANCH_SLICE_LIMIT);
      if (!awaitingBranches.includes(slice)) awaitingBranches.push(slice);
    }
  };
  new Visitor({
    ReturnStatement(node) {
      if (!inScope(node) || !node.argument) return;
      recordBranch(node.argument);
    },
    ArrowFunctionExpression(node) {
      if (node.start !== candidate.start || node.end !== candidate.end) return;
      if (node.body.type === "BlockStatement") return;
      recordBranch(node.body);
    },
  }).visit(parsed.program);

  const awaitingCallSites: string[] = [];
  const thenChains: string[] = [];
  const promiseCombinators: string[] = [];
  const plainCallSites: string[] = [];
  for (const file of projectFiles) {
    const fileParsed = parseCached(file.filePath, file.source);
    if (fileParsed.errors.some((error) => error.severity === "Error")) continue;
    new Visitor({
      AwaitExpression(node) {
        const text = file.source.slice(node.start, node.end).slice(0, 400);
        if (containsCallTo(text, name)) awaitingCallSites.push(`${file.filePath}: ${text}`);
      },
      CallExpression(node) {
        const text = file.source.slice(node.start, node.end).slice(0, 400);
        if (!containsCallTo(text, name)) return;
        if (THEN_CHAIN_PATTERN.test(text)) thenChains.push(`${file.filePath}: ${text}`);
        else if (COMBINATOR_PATTERN.test(text)) {
          promiseCombinators.push(`${file.filePath}: ${text}`);
        } else {
          const enclosing = file.source.slice(Math.max(0, node.start - 6), node.start);
          if (/await\s*$/.test(enclosing)) return;
          plainCallSites.push(`${file.filePath}: ${text}`);
        }
      },
    }).visit(fileParsed.program);
  }

  return {
    function: {
      name,
      exported: isFunctionExported(parsed.program, fn, name),
      filePath: candidate.filePath,
      source: candidate.source,
    },
    awaitingBranches,
    callerUsage: {
      awaitingCallSites: awaitingCallSites.slice(0, 10),
      thenChains: thenChains.slice(0, 10),
      promiseCombinators: promiseCombinators.slice(0, 10),
      plainCallSites: plainCallSites.slice(0, 10),
    },
    callers: findFunctionCallers(candidate.filePath, name, projectFiles),
  };
}
