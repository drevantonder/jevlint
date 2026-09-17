import { parseSync } from "oxc-parser";
import type { Candidate, ProjectFile } from "../types.js";
import {
  findDirectFunction,
  findFunctionCallers,
  functionName,
  isFunctionExported,
} from "./repository.js";
import type { FunctionCaller, FunctionNode } from "./repository.js";

export type SpeculativeGeneralityEvidence = {
  function: {
    name: string;
    exported: boolean;
    filePath: string;
    source: string;
    moduleSource: string;
  };
  extensionSignals: string[];
  callers: FunctionCaller[];
  observedArgumentLists: string[][];
};

function extensionSignals(fn: FunctionNode, ownerSource: string): string[] {
  const signals: string[] = [];
  for (const parameter of fn.params.slice(1)) {
    const source = ownerSource.slice(parameter.start, parameter.end);
    const looksExtensible = /[?=]|=>/.test(source)
      || /\b(?:options?|config|hooks?|callbacks?|strateg(?:y|ies)|plugins?|transform|resolver|factory|handler)\w*\b/i.test(source);
    if (looksExtensible) signals.push(`extension parameter: ${source}`);
  }
  if (fn.typeParameters) {
    signals.push(`generic type parameters: ${ownerSource.slice(fn.typeParameters.start, fn.typeParameters.end)}`);
  }
  const functionSource = ownerSource.slice(fn.start, fn.end);
  const semanticSignals = [
    "options",
    "config",
    "hook",
    "callback",
    "strategy",
    "plugin",
    "transform",
    "before",
    "after",
    "resolver",
    "factory",
    "handler",
  ];
  for (const signal of semanticSignals) {
    if (new RegExp(`\\b${signal}\\w*`, "i").test(functionSource)) {
      signals.push(`extension vocabulary: ${signal}`);
    }
  }
  return [...new Set(signals)];
}

function uniqueArgumentLists(callers: FunctionCaller[]): string[][] {
  const seen = new Set<string>();
  const result: string[][] = [];
  for (const caller of callers) {
    const key = JSON.stringify(caller.arguments);
    if (seen.has(key)) continue;
    seen.add(key);
    result.push(caller.arguments);
  }
  return result;
}

export function buildSpeculativeGeneralityEvidence(
  candidate: Candidate,
  projectFiles: ProjectFile[],
): SpeculativeGeneralityEvidence | undefined {
  if (candidate.kind !== "function") return undefined;
  const owner = projectFiles.find((file) => file.filePath === candidate.filePath);
  if (!owner) return undefined;
  const parsed = parseSync(owner.filePath, owner.source, { range: true });
  if (parsed.errors.some((error) => error.severity === "Error")) return undefined;
  const fn = findDirectFunction(parsed.program, candidate);
  if (!fn) return undefined;
  const name = functionName(parsed.program, fn);
  if (!name) return undefined;
  const signals = extensionSignals(fn, owner.source);
  if (signals.length === 0) return undefined;
  const callers = findFunctionCallers(candidate.filePath, name, projectFiles);

  return {
    function: {
      name,
      exported: isFunctionExported(parsed.program, fn, name),
      filePath: candidate.filePath,
      source: candidate.source,
      moduleSource: owner.source.slice(0, 16_000),
    },
    extensionSignals: signals,
    callers,
    observedArgumentLists: uniqueArgumentLists(callers),
  };
}
