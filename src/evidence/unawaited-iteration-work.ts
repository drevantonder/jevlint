import { Visitor } from "oxc-parser";
import { parseCached } from "./parse-cache.js";
import type { CallExpression, Expression, Node } from "oxc-parser";
import type { Candidate, ProjectFile } from "../types.js";
import {
  belongsDirectlyToFunction,
  containsNode,
  nestedFunctionRanges,
} from "./function-scope.js";
import type { NodeRange } from "./function-scope.js";
import {
  findDirectFunction,
  findFunctionCallers,
  functionName,
  isFunctionExported,
} from "./repository.js";
import type { FunctionCaller } from "./repository.js";

const ITERATION_METHODS = new Set(["forEach", "each", "map", "setTimeout", "setInterval"]);

export type IterationSite = {
  call: string;
  method: string;
  callbackAsync: boolean;
  callbackSource: string | null;
  awaitedCall: boolean;
  settledSignals: string[];
};

export type UnawaitedIterationWorkEvidence = {
  function: {
    name: string | null;
    exported: boolean;
    filePath: string;
    source: string;
  };
  iterations: IterationSite[];
  tryCatchRegions: string[];
  repository: {
    callers: FunctionCaller[];
  };
};

function nodeSource(node: Node, source: string): string {
  return source.slice(node.start, node.end);
}

function methodName(call: CallExpression): string | undefined {
  if (call.callee.type === "MemberExpression" && call.callee.property.type === "Identifier") {
    return call.callee.property.name;
  }
  return undefined;
}

function callbackArgument(call: CallExpression): Expression | undefined {
  const first = call.arguments[0];
  if (!first) return undefined;
  const value = first.type === "SpreadElement" ? first.argument : first;
  return value.type === "ArrowFunctionExpression" || value.type === "FunctionExpression"
    ? value
    : undefined;
}

function callbackIsAsync(callback: Expression, program: Parameters<Visitor["visit"]>[0]): boolean {
  if (callback.type !== "ArrowFunctionExpression" && callback.type !== "FunctionExpression") {
    return false;
  }
  if (callback.async) return true;
  let found = false;
  new Visitor({
    AwaitExpression(node) {
      if (containsNode(callback, node)) found = true;
    },
  }).visit(program);
  return found;
}

export function buildUnawaitedIterationWorkEvidence(
  candidate: Candidate,
  projectFiles: ProjectFile[],
): UnawaitedIterationWorkEvidence | undefined {
  if (candidate.kind !== "function") return undefined;
  const ownerFile = projectFiles.find((file) => file.filePath === candidate.filePath);
  if (!ownerFile) return undefined;
  const parsed = parseCached(ownerFile.filePath, ownerFile.source);
  if (parsed.errors.some((error) => error.severity === "Error")) return undefined;
  const fn = findDirectFunction(parsed.program, candidate);
  if (!fn) return undefined;

  const nested = nestedFunctionRanges(parsed.program, fn);
  const nestedAndCallbacks: NodeRange[] = [...nested];
  const iterations: IterationSite[] = [];

  new Visitor({
    CallExpression(call) {
      if (!containsNode(fn, call)) return;
      const method = methodName(call);
      if (!method || !ITERATION_METHODS.has(method)) return;
      const callback = callbackArgument(call);
      if (!callback) return;
      if (!callbackIsAsync(callback, parsed.program)) return;
      nestedAndCallbacks.push({ start: callback.start, end: callback.end });
      const prefix = ownerFile.source.slice(Math.max(0, call.start - 6), call.start);
      const settledSignals = [...ownerFile.source.slice(fn.start, fn.end).matchAll(
        /Promise\s*\.\s*all(?:Settled)?\s*\(/g,
      )].map((match) => match[0]);
      iterations.push({
        call: nodeSource(call, ownerFile.source),
        method,
        callbackAsync: callback.type === "ArrowFunctionExpression" || callback.type === "FunctionExpression"
          ? Boolean(callback.async)
          : false,
        callbackSource: nodeSource(callback, ownerFile.source),
        awaitedCall: /await\s*$/.test(prefix),
        settledSignals,
      });
    },
  }).visit(parsed.program);

  if (iterations.length === 0) return undefined;

  const tryCatchRegions: string[] = [];
  new Visitor({
    TryStatement(node) {
      if (!containsNode(fn, node) || !belongsDirectlyToFunction(node, nested)) return;
      const body = nodeSource(node, ownerFile.source);
      if (iterations.some(({ call }) => body.includes(call))) tryCatchRegions.push(body);
    },
  }).visit(parsed.program);

  const name = functionName(parsed.program, fn);
  return {
    function: {
      name: name ?? null,
      exported: name ? isFunctionExported(parsed.program, fn, name) : false,
      filePath: candidate.filePath,
      source: candidate.source,
    },
    iterations,
    tryCatchRegions,
    repository: {
      callers: name ? findFunctionCallers(candidate.filePath, name, projectFiles) : [],
    },
  };
}
