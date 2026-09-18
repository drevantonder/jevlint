import { Visitor } from "oxc-parser";
import { parseCached } from "./parse-cache.js";
import type { Function as OxcFunction } from "oxc-parser";
import type { Candidate, ProjectFile } from "../types.js";
import {
  findDirectFunction,
  findFunctionCallersWithCoverage,
  functionName,
  isFunctionExported,
} from "./repository.js";
import type { FunctionCaller, FunctionNode } from "./repository.js";

const MAX_OVERLOADS = 8;
const MAX_EXCERPT_CHARS = 500;

export type OverloadSignature = {
  arity: number;
  parameterTypes: string[];
  returnType: string | null;
  excerpt: string;
};

export type AmbiguousOverloadPair = {
  first: number;
  second: number;
  sameArity: boolean;
  overlappingParameters: number[];
  returnOnlyDifference: boolean;
};

export type OverloadResolutionAmbiguityEvidence = {
  function: {
    name: string;
    exported: boolean;
    filePath: string;
    source: string;
  };
  overloads: OverloadSignature[];
  implementation: {
    requiredParameters: number;
    totalParameters: number;
    widerThanEveryOverload: boolean;
    excerpt: string;
  } | null;
  ambiguousPairs: AmbiguousOverloadPair[];
  separatelyNamedVariants: string[];
  callers: FunctionCaller[];
  callSummary: {
    total: number;
    matchingMultipleOverloads: number;
    distinctArgumentCounts: number[];
  };
};

function normalizeType(text: string): string {
  return text.trim().toLowerCase().replace(/\s+/g, " ");
}

function parameterTypeText(parameter: FunctionNode["params"][number], source: string): string {
  const value = parameter.type === "TSParameterProperty" ? parameter.parameter : parameter;
  const text = source.slice(parameter.start, parameter.end).trim();
  if (value.type === "RestElement") {
    const annotation = /:\s*(.+)$/.exec(text)?.[1] ?? "unknown[]";
    return `...${normalizeType(annotation)}`;
  }
  const withoutDefault = text.includes("=") ? text.slice(0, text.indexOf("=")) : text;
  const annotation = /:\s*(.+?)(\?\s*)?$/.exec(withoutDefault)?.[1];
  if (annotation) return normalizeType(annotation);
  return "unknown";
}

function unionMembers(normalized: string): string[] {
  return normalized.split("|").map((part) => part.trim()).filter((part) => part.length > 0);
}

function typesOverlap(first: string, second: string): boolean {
  if (first === second) return true;
  if (first === "any" || second === "any" || first === "unknown" || second === "unknown") return true;
  const firstMembers = unionMembers(first);
  const secondMembers = unionMembers(second);
  if (firstMembers.length > 1 || secondMembers.length > 1) {
    return firstMembers.some((member) => secondMembers.includes(member));
  }
  return false;
}

function returnTypeOf(node: OxcFunction, source: string): string | null {
  const paramsEnd = node.params.length > 0 ? node.params[node.params.length - 1]?.end : undefined;
  const bodyStart = node.body?.start;
  if (paramsEnd === undefined || bodyStart === undefined) return null;
  const between = source.slice(paramsEnd, bodyStart);
  const match = /\)\s*:\s*(.+?)\s*$/.exec(between.trim());
  return match?.[1] ? normalizeType(match[1]) : null;
}

function signatureOf(node: OxcFunction, source: string): OverloadSignature {
  return {
    arity: node.params.length,
    parameterTypes: node.params.map((parameter) => parameterTypeText(parameter, source)),
    returnType: returnTypeOf(node, source),
    excerpt: source.slice(node.start, node.end).slice(0, MAX_EXCERPT_CHARS),
  };
}

function requiredParameters(node: FunctionNode | OxcFunction, source: string): number {
  return node.params.filter((parameter) => {
    const text = source.slice(parameter.start, parameter.end).trim();
    if (text.includes("=")) return false;
    if (parameter.type === "RestElement") return false;
    return !/\?\s*:/.test(text) && !text.endsWith("?");
  }).length;
}

export function buildOverloadResolutionAmbiguityEvidence(
  candidate: Candidate,
  projectFiles: ProjectFile[],
): OverloadResolutionAmbiguityEvidence | undefined {
  if (candidate.kind !== "function") return undefined;
  const owner = projectFiles.find((file) => file.filePath === candidate.filePath);
  if (!owner) return undefined;
  const parsed = parseCached(owner.filePath, owner.source);
  if (parsed.errors.some((error) => error.severity === "Error")) return undefined;
  const fn = findDirectFunction(parsed.program, candidate);
  if (!fn) return undefined;
  const name = functionName(parsed.program, fn);
  if (!name) return undefined;

  const overloadNodes: OxcFunction[] = [];
  new Visitor({
    TSDeclareFunction(node: OxcFunction) {
      if (node.id?.name === name && overloadNodes.length < MAX_OVERLOADS) {
        overloadNodes.push(node);
      }
    },
  }).visit(parsed.program);
  if (overloadNodes.length < 2) return undefined;

  const overloads = overloadNodes.map((node) => signatureOf(node, owner.source));

  const ambiguousPairs: AmbiguousOverloadPair[] = [];
  for (let first = 0; first < overloads.length; first += 1) {
    for (let second = first + 1; second < overloads.length; second += 1) {
      const left = overloads[first];
      const right = overloads[second];
      if (!left || !right) continue;
      const sameArity = left.arity === right.arity;
      const overlappingParameters: number[] = [];
      if (sameArity) {
        for (let index = 0; index < left.arity; index += 1) {
          const leftType = left.parameterTypes[index] ?? "unknown";
          const rightType = right.parameterTypes[index] ?? "unknown";
          if (typesOverlap(leftType, rightType)) overlappingParameters.push(index);
        }
      }
      const paramsIdentical = sameArity
        && left.parameterTypes.every((type, index) => type === right.parameterTypes[index]);
      const returnOnlyDifference = paramsIdentical
        && left.returnType !== null
        && right.returnType !== null
        && left.returnType !== right.returnType;
      if ((sameArity && overlappingParameters.length > 0) || returnOnlyDifference) {
        ambiguousPairs.push({
          first,
          second,
          sameArity,
          overlappingParameters,
          returnOnlyDifference,
        });
      }
    }
  }

  const required = requiredParameters(fn, owner.source);
  const implementation = {
    requiredParameters: required,
    totalParameters: fn.params.length,
    widerThanEveryOverload: overloads.every((overload) => required <= overload.arity),
    excerpt: owner.source.slice(fn.start, fn.end).slice(0, MAX_EXCERPT_CHARS),
  };

  const variants = new Set<string>();
  for (const statement of parsed.program.body) {
    if (variants.size >= 6) break;
    const declaration = statement.type === "ExportNamedDeclaration" ? statement.declaration : statement;
    const entries: string[] = [];
    if (declaration?.type === "FunctionDeclaration" && declaration.id) {
      entries.push(declaration.id.name);
    } else if (declaration?.type === "VariableDeclaration") {
      for (const item of declaration.declarations) {
        if (item.id.type === "Identifier" && item.init
          && (item.init.type === "ArrowFunctionExpression" || item.init.type === "FunctionExpression")) {
          entries.push(item.id.name);
        }
      }
    }
    for (const entry of entries) {
      if (entry === name) continue;
      if (entry.startsWith(name) || name.startsWith(entry)) variants.add(entry);
    }
  }

  const coverage = findFunctionCallersWithCoverage(candidate.filePath, name, projectFiles);
  const matchingMultipleOverloads = coverage.callers.filter((caller) =>
    overloads.filter((overload) => overload.arity === caller.arguments.length).length >= 2
  ).length;

  return {
    function: {
      name,
      exported: isFunctionExported(parsed.program, fn, name),
      filePath: candidate.filePath,
      source: candidate.source,
    },
    overloads,
    implementation,
    ambiguousPairs,
    separatelyNamedVariants: [...variants],
    callers: coverage.callers.slice(0, 20),
    callSummary: {
      total: coverage.total,
      matchingMultipleOverloads,
      distinctArgumentCounts: [...new Set(coverage.callers.map((caller) => caller.arguments.length))]
        .sort((left, right) => left - right).slice(0, 10),
    },
  };
}
