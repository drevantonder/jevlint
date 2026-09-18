import { Visitor } from "oxc-parser";
import { parseCached } from "./parse-cache.js";
import type { Node } from "oxc-parser";
import type { Candidate, ProjectFile } from "../types.js";
import {
  findDirectFunction,
  findFunctionCallers,
  functionName,
  isFunctionExported,
  isInsideNestedFunction,
  nestedFunctionRanges,
} from "./repository.js";
import type { FunctionCaller } from "./repository.js";

export type LoadBearingAsyncEvidence = {
  function: {
    name: string;
    exported: boolean;
    filePath: string;
    source: string;
  };
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
    callerUsage: {
      awaitingCallSites: awaitingCallSites.slice(0, 10),
      thenChains: thenChains.slice(0, 10),
      promiseCombinators: promiseCombinators.slice(0, 10),
      plainCallSites: plainCallSites.slice(0, 10),
    },
    callers: findFunctionCallers(candidate.filePath, name, projectFiles),
  };
}
