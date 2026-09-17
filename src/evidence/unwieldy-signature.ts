import { parseSync, Visitor } from "oxc-parser";
import type { Function as OxcFunction, Program } from "oxc-parser";
import type { Candidate, ProjectFile } from "../types.js";
import {
  findDirectFunction,
  findFunctionCallersWithCoverage,
  functionName,
  isFunctionExported,
} from "./repository.js";
import type { FunctionCaller, FunctionNode } from "./repository.js";

export type SignatureParameter = {
  name: string;
  rest: boolean;
  optional: boolean;
  hasDefault: boolean;
  booleanTyped: boolean;
  optionsBag: boolean;
  referencedInBody: boolean;
};

export type CallerSummary = {
  total: number;
  included: number;
  withUndefinedPlaceholder: number;
  distinctArgumentCounts: number[];
};

export type UnwieldySignatureEvidence = {
  function: {
    name: string;
    exported: boolean;
    filePath: string;
    source: string;
  };
  signature: {
    totalParameters: number;
    positional: string[];
    optionsBag: string | null;
    booleanParameters: string[];
    optionalParameters: string[];
    defaultedParameters: string[];
    unreferencedParameters: string[];
    overloads: string[];
  };
  callers: FunctionCaller[];
  callSummary: CallerSummary;
};

function bindingName(parameter: FunctionNode["params"][number]): string | undefined {
  const value = parameter.type === "TSParameterProperty" ? parameter.parameter : parameter;
  if (value.type === "Identifier") return value.name;
  if (value.type === "AssignmentPattern" && value.left.type === "Identifier") {
    return value.left.name;
  }
  if (value.type === "RestElement" && value.argument.type === "Identifier") {
    return value.argument.name;
  }
  if (value.type === "ObjectPattern" || value.type === "ArrayPattern") return "destructured";
  return undefined;
}

function isRest(parameter: FunctionNode["params"][number]): boolean {
  const value = parameter.type === "TSParameterProperty" ? parameter.parameter : parameter;
  return value.type === "RestElement";
}

function isOptional(parameter: FunctionNode["params"][number], source: string): boolean {
  const value = parameter.type === "TSParameterProperty" ? parameter.parameter : parameter;
  if (value.type === "RestElement") return false;
  if (value.type === "AssignmentPattern") return false;
  const text = source.slice(parameter.start, parameter.end);
  return /\?\s*:/.test(text) || /\?\s*$/.test(text);
}

function hasDefault(parameter: FunctionNode["params"][number]): boolean {
  const value = parameter.type === "TSParameterProperty" ? parameter.parameter : parameter;
  return value.type === "AssignmentPattern";
}

function isDestructured(parameter: FunctionNode["params"][number]): boolean {
  const value = parameter.type === "TSParameterProperty" ? parameter.parameter : parameter;
  if (value.type === "ObjectPattern" || value.type === "ArrayPattern") return true;
  if (value.type === "AssignmentPattern") {
    return value.left.type === "ObjectPattern" || value.left.type === "ArrayPattern";
  }
  return false;
}

function isBooleanTyped(parameter: FunctionNode["params"][number], source: string): boolean {
  const text = source.slice(parameter.start, parameter.end);
  return /:\s*boolean\b/.test(text);
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function isReferenced(name: string, bodySource: string): boolean {
  const pattern = new RegExp(`\\b${escapeRegExp(name)}\\b`, "g");
  const dotted = new RegExp(`\\.\\s*${escapeRegExp(name)}\\b`, "g");
  const total = bodySource.match(pattern)?.length ?? 0;
  const viaMember = bodySource.match(dotted)?.length ?? 0;
  return total - viaMember > 0;
}

function bodySource(fn: FunctionNode, ownerSource: string): string {
  if (!fn.body) return "";
  return ownerSource.slice(fn.body.start, fn.body.end);
}

function overloadSources(
  program: Program,
  name: string,
  ownerSource: string,
): string[] {
  const overloads: string[] = [];
  new Visitor({
    TSDeclareFunction(node: OxcFunction) {
      if (node.id?.name === name) {
        overloads.push(ownerSource.slice(node.start, node.end).slice(0, 500));
      }
    },
  }).visit(program);
  return overloads.slice(0, 5);
}

function undefinedPlaceholders(caller: FunctionCaller): number {
  return caller.arguments.filter((argument) => argument.trim() === "undefined").length;
}

export function buildUnwieldySignatureEvidence(
  candidate: Candidate,
  projectFiles: ProjectFile[],
): UnwieldySignatureEvidence | undefined {
  if (candidate.kind !== "function") return undefined;
  const owner = projectFiles.find((file) => file.filePath === candidate.filePath);
  if (!owner) return undefined;
  const parsed = parseSync(owner.filePath, owner.source, { range: true });
  if (parsed.errors.some((error) => error.severity === "Error")) return undefined;
  const fn: FunctionNode | OxcFunction | undefined = findDirectFunction(parsed.program, candidate);
  if (!fn) return undefined;
  const name = functionName(parsed.program, fn);
  if (!name) return undefined;
  if (fn.params.length === 0) return undefined;

  const body = bodySource(fn, owner.source);
  const parameters: SignatureParameter[] = fn.params.flatMap((parameter) => {
    const paramName = bindingName(parameter);
    if (paramName === undefined) return [];
    return [{
      name: paramName,
      rest: isRest(parameter),
      optional: isOptional(parameter, owner.source),
      hasDefault: hasDefault(parameter),
      booleanTyped: isBooleanTyped(parameter, owner.source),
      optionsBag: isDestructured(parameter),
      referencedInBody: isReferenced(paramName, body),
    }];
  });
  if (parameters.length === 0) return undefined;

  const positional = parameters
    .filter(({ rest, optionsBag }) => !rest && !optionsBag)
    .map(({ name: paramName }) => paramName);
  const optionsBag = parameters.find(({ optionsBag }) => optionsBag)?.name ?? null;
  const coverage = findFunctionCallersWithCoverage(candidate.filePath, name, projectFiles);

  return {
    function: {
      name,
      exported: isFunctionExported(parsed.program, fn, name),
      filePath: candidate.filePath,
      source: candidate.source,
    },
    signature: {
      totalParameters: parameters.length,
      positional,
      optionsBag,
      booleanParameters: parameters.filter(({ booleanTyped }) => booleanTyped).map(({ name: paramName }) => paramName),
      optionalParameters: parameters.filter(({ optional }) => optional).map(({ name: paramName }) => paramName),
      defaultedParameters: parameters.filter(({ hasDefault }) => hasDefault).map(({ name: paramName }) => paramName),
      unreferencedParameters: parameters
        .filter(({ referencedInBody, rest }) => !referencedInBody && !rest)
        .map(({ name: paramName }) => paramName),
      overloads: overloadSources(parsed.program, name, owner.source),
    },
    callers: coverage.callers.slice(0, 20),
    callSummary: {
      total: coverage.total,
      included: Math.min(coverage.total, 20),
      withUndefinedPlaceholder: coverage.callers.filter((caller) => undefinedPlaceholders(caller) > 0).length,
      distinctArgumentCounts: [...new Set(coverage.callers.map((caller) => caller.arguments.length))].sort((a, b) => a - b).slice(0, 10),
    },
  };
}
