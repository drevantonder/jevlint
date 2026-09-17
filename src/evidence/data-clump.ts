import { parseSync, Visitor } from "oxc-parser";
import type { Program } from "oxc-parser";
import type { Candidate, ProjectFile } from "../types.js";
import {
  findDirectFunction,
  findFunctionCallers,
  functionName,
  isFunctionExported,
} from "./repository.js";
import type { FunctionCaller, FunctionNode } from "./repository.js";

type ParameterEvidence = {
  name: string;
  type: string | null;
  source: string;
};

type RepeatedFunction = {
  filePath: string;
  name: string;
  source: string;
  parameters: ParameterEvidence[];
  callers: FunctionCaller[];
};

export type DataClumpEvidence = {
  function: {
    name: string;
    exported: boolean;
    filePath: string;
    source: string;
    parameters: ParameterEvidence[];
  };
  repeatedGroup: string[];
  occurrences: RepeatedFunction[];
  callers: FunctionCaller[];
};

type IndexedFunction = {
  filePath: string;
  program: Program;
  node: FunctionNode;
  name: string;
  source: string;
  parameters: ParameterEvidence[];
};

function parametersOf(node: FunctionNode, source: string): ParameterEvidence[] {
  return node.params.flatMap((parameter): ParameterEvidence[] => {
    if (parameter.type !== "Identifier") return [];
    const annotation = parameter.typeAnnotation;
    return [{
      name: parameter.name,
      type: annotation
        ? source.slice(annotation.start, annotation.end).replace(/^:\s*/, "")
        : null,
      source: source.slice(parameter.start, parameter.end),
    }];
  });
}

function functionsIn(file: ProjectFile): IndexedFunction[] {
  const parsed = parseSync(file.filePath, file.source, { range: true });
  if (parsed.errors.some((error) => error.severity === "Error")) return [];
  const functions: IndexedFunction[] = [];
  const add = (node: FunctionNode): void => {
    const name = functionName(parsed.program, node);
    if (!name) return;
    functions.push({
      filePath: file.filePath,
      program: parsed.program,
      node,
      name,
      source: file.source.slice(node.start, node.end),
      parameters: parametersOf(node, file.source),
    });
  };
  new Visitor({
    ArrowFunctionExpression: add,
    FunctionDeclaration: add,
    FunctionExpression: add,
  }).visit(parsed.program);
  return functions;
}

function sharedNames(candidateNames: Set<string>, parameters: ParameterEvidence[]): string[] {
  return parameters
    .map(({ name }) => name)
    .filter((name) => candidateNames.has(name))
    .sort();
}

function includesGroup(parameters: ParameterEvidence[], group: string[]): boolean {
  const names = new Set(parameters.map(({ name }) => name));
  return group.every((name) => names.has(name));
}

export function buildDataClumpEvidence(
  candidate: Candidate,
  projectFiles: ProjectFile[],
): DataClumpEvidence | undefined {
  if (candidate.kind !== "function") return undefined;
  const owner = projectFiles.find((file) => file.filePath === candidate.filePath);
  if (!owner) return undefined;
  const parsed = parseSync(owner.filePath, owner.source, { range: true });
  if (parsed.errors.some((error) => error.severity === "Error")) return undefined;
  const fn = findDirectFunction(parsed.program, candidate);
  if (!fn) return undefined;
  const name = functionName(parsed.program, fn);
  if (!name) return undefined;
  const parameters = parametersOf(fn, owner.source);
  if (parameters.length < 3) return undefined;
  const candidateNames = new Set(parameters.map((parameter) => parameter.name));

  const otherFunctions = projectFiles
    .flatMap(functionsIn)
    .filter((item) =>
      item.filePath !== owner.filePath
      || item.node.start !== fn.start
      || item.node.end !== fn.end,
    );
  const possibleGroups = new Map<string, string[]>();
  for (const item of otherFunctions) {
    const group = sharedNames(candidateNames, item.parameters);
    if (group.length >= 3) possibleGroups.set(JSON.stringify(group), group);
  }

  const supportedGroups = [...possibleGroups.values()].flatMap((group) => {
    const occurrences = otherFunctions.filter((item) => includesGroup(item.parameters, group));
    return occurrences.length >= 2 ? [{ group, occurrences }] : [];
  }).sort((left, right) =>
    right.group.length - left.group.length
    || right.occurrences.length - left.occurrences.length
    || left.group.join("\0").localeCompare(right.group.join("\0")),
  );
  const selected = supportedGroups[0];
  if (!selected) return undefined;

  return {
    function: {
      name,
      exported: isFunctionExported(parsed.program, fn, name),
      filePath: owner.filePath,
      source: candidate.source,
      parameters,
    },
    repeatedGroup: selected.group,
    occurrences: selected.occurrences.slice(0, 12).map((item) => ({
      filePath: item.filePath,
      name: item.name,
      source: item.source.slice(0, 8_000),
      parameters: item.parameters,
      callers: findFunctionCallers(item.filePath, item.name, projectFiles),
    })),
    callers: findFunctionCallers(owner.filePath, name, projectFiles),
  };
}
