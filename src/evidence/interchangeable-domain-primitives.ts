import { parseCached } from "./parse-cache.js";
import type { ParamPattern } from "oxc-parser";
import type { Candidate, ProjectFile } from "../types.js";
import {
  findDirectFunction,
  findFunctionCallers,
  functionName,
  isFunctionExported,
} from "./repository.js";
import type { FunctionCaller } from "./repository.js";

export type PrimitiveType = "string" | "number" | "bigint" | "boolean";

type PrimitiveParameter = {
  index: number;
  name: string;
  source: string;
};

export type InterchangeableDomainPrimitivesEvidence = {
  function: {
    name: string;
    exported: boolean;
    filePath: string;
    source: string;
    moduleSource: string;
  };
  primitiveGroups: Array<{
    type: PrimitiveType;
    parameters: PrimitiveParameter[];
  }>;
  callers: FunctionCaller[];
  consumers: Array<{ filePath: string; source: string }>;
};

function parameterName(parameter: ParamPattern): string | undefined {
  if (parameter.type === "Identifier") return parameter.name;
  if (parameter.type === "TSParameterProperty") return parameterName(parameter.parameter);
  if (parameter.type === "RestElement" && parameter.argument.type === "Identifier") {
    return parameter.argument.name;
  }
  if (parameter.type === "AssignmentPattern" && parameter.left.type === "Identifier") {
    return parameter.left.name;
  }
  return undefined;
}

function primitiveType(source: string): PrimitiveType | undefined {
  const value = /:\s*(string|number|bigint|boolean)\s*(?:=.+)?$/s.exec(source.trim())?.[1];
  if (value === "string" || value === "number" || value === "bigint" || value === "boolean") {
    return value;
  }
  return undefined;
}

function consumerModules(
  callers: FunctionCaller[],
  projectFiles: ProjectFile[],
): Array<{ filePath: string; source: string }> {
  const paths = new Set(callers.map(({ filePath }) => filePath));
  return projectFiles
    .filter(({ filePath }) => paths.has(filePath))
    .slice(0, 20)
    .map(({ filePath, source }) => ({ filePath, source: source.slice(0, 12_000) }));
}

export function buildInterchangeableDomainPrimitivesEvidence(
  candidate: Candidate,
  projectFiles: ProjectFile[],
): InterchangeableDomainPrimitivesEvidence | undefined {
  if (candidate.kind !== "function") return undefined;
  const owner = projectFiles.find(({ filePath }) => filePath === candidate.filePath);
  if (!owner) return undefined;
  const parsed = parseCached(owner.filePath, owner.source);
  if (parsed.errors.some(({ severity }) => severity === "Error")) return undefined;
  const fn = findDirectFunction(parsed.program, candidate);
  if (!fn) return undefined;
  const name = functionName(parsed.program, fn);
  if (!name || !isFunctionExported(parsed.program, fn, name)) return undefined;

  const groups = new Map<PrimitiveType, PrimitiveParameter[]>();
  for (const [index, parameter] of fn.params.entries()) {
    const parameterSource = owner.source.slice(parameter.start, parameter.end);
    const parameterIdentifier = parameterName(parameter);
    const type = primitiveType(parameterSource);
    if (!parameterIdentifier || !type) continue;
    const parameters = groups.get(type) ?? [];
    parameters.push({ index, name: parameterIdentifier, source: parameterSource });
    groups.set(type, parameters);
  }
  const primitiveGroups = [...groups.entries()]
    .filter(([, parameters]) => parameters.length >= 2)
    .map(([type, parameters]) => ({ type, parameters }));
  if (primitiveGroups.length === 0) return undefined;

  const callers = findFunctionCallers(owner.filePath, name, projectFiles);
  if (callers.length === 0) return undefined;
  return {
    function: {
      name,
      exported: true,
      filePath: owner.filePath,
      source: candidate.source,
      moduleSource: owner.source.slice(0, 16_000),
    },
    primitiveGroups,
    callers,
    consumers: consumerModules(callers, projectFiles),
  };
}
