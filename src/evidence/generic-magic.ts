import { Visitor } from "oxc-parser";
import { parseCached } from "./parse-cache.js";
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

export type GenericMagicEvidence = {
  function: {
    name: string;
    exported: boolean;
    filePath: string;
    source: string;
    moduleSource: string;
  };
  dynamicOperations: string[];
  callers: FunctionCaller[];
  observedArgumentLists: string[][];
};

function uniqueArgumentLists(callers: FunctionCaller[]): string[][] {
  const argumentLists = new Map<string, string[]>();
  for (const caller of callers) {
    argumentLists.set(JSON.stringify(caller.arguments), caller.arguments);
  }
  return [...argumentLists.values()];
}

export function buildGenericMagicEvidence(
  candidate: Candidate,
  projectFiles: ProjectFile[],
): GenericMagicEvidence | undefined {
  if (candidate.kind !== "function") return undefined;
  const owner = projectFiles.find((file) => file.filePath === candidate.filePath);
  if (!owner) return undefined;
  const parsed = parseCached(owner.filePath, owner.source);
  if (parsed.errors.some((error) => error.severity === "Error")) return undefined;
  const fn = findDirectFunction(parsed.program, candidate);
  if (!fn) return undefined;
  const name = functionName(parsed.program, fn);
  if (!name) return undefined;

  const operations = new Set<string>();
  const nestedFunctions = nestedFunctionRanges(parsed.program, candidate);
  new Visitor({
    CallExpression(node) {
      if (
        node.start < candidate.start
        || node.end > candidate.end
        || isInsideNestedFunction(node, nestedFunctions)
      ) return;
      const callee = node.callee;
      if (
        callee.type === "MemberExpression"
        && !callee.computed
        && callee.object.type === "Identifier"
        && (callee.object.name === "Object" || callee.object.name === "Reflect")
      ) operations.add(owner.source.slice(callee.start, callee.end));
    },
    MemberExpression(node) {
      if (
        node.start < candidate.start
        || node.end > candidate.end
        || isInsideNestedFunction(node, nestedFunctions)
        || !node.computed
      ) return;
      operations.add(owner.source.slice(node.start, node.end));
    },
    NewExpression(node) {
      if (
        node.start >= candidate.start
        && node.end <= candidate.end
        && !isInsideNestedFunction(node, nestedFunctions)
        && node.callee.type === "Identifier"
        && node.callee.name === "Proxy"
      ) operations.add("new Proxy");
    },
  }).visit(parsed.program);
  if (operations.size === 0) return undefined;

  const callers = findFunctionCallers(candidate.filePath, name, projectFiles);
  return {
    function: {
      name,
      exported: isFunctionExported(parsed.program, fn, name),
      filePath: candidate.filePath,
      source: candidate.source,
      moduleSource: owner.source.slice(0, 16_000),
    },
    dynamicOperations: [...operations],
    callers,
    observedArgumentLists: uniqueArgumentLists(callers),
  };
}
