import { parseSync, Visitor } from "oxc-parser";
import type { Program } from "oxc-parser";
import type { Candidate, ProjectFile } from "../types.js";
import { belongsDirectlyToFunction, nestedFunctionRanges } from "./function-scope.js";
import {
  findDirectFunction,
  findFunctionCallers,
  functionName,
  isFunctionExported,
} from "./repository.js";
import type { FunctionCaller, FunctionNode } from "./repository.js";

export type AffixGroup = {
  affix: string;
  kind: "prefix" | "suffix";
  parameters: string[];
};

export type SiblingOverlap = {
  name: string;
  overlap: string[];
};

export type ObjectSpreadCall = {
  filePath: string;
  call: string;
  line: number;
  commonRoot: string;
  memberArgumentCount: number;
};

export type UnnamedParameterObjectEvidence = {
  function: {
    name: string;
    exported: boolean;
    filePath: string;
    source: string;
    parameterCount: number;
    parameters: string[];
  };
  cohesion: {
    sharedAffixGroups: AffixGroup[];
    packsParametersIntoObject: boolean;
    packedObject: string | null;
  };
  siblingOverlap: SiblingOverlap[];
  callers: FunctionCaller[];
  objectSpreadCalls: ObjectSpreadCall[];
};

function namedParameter(parameter: FunctionNode["params"][number]): string | undefined {
  const value = parameter.type === "TSParameterProperty" ? parameter.parameter : parameter;
  if (value.type === "Identifier") return value.name;
  if (value.type === "AssignmentPattern" && value.left.type === "Identifier") {
    return value.left.name;
  }
  if (value.type === "RestElement" && value.argument.type === "Identifier") {
    return value.argument.name;
  }
  return undefined;
}

function splitWords(name: string): string[] {
  return name
    .replace(/([a-z0-9])([A-Z])/g, "$1 $2")
    .split(/[^A-Za-z0-9]+/)
    .map((word) => word.toLowerCase())
    .filter((word) => word.length > 0);
}

function sharedAffixGroups(parameters: string[]): AffixGroup[] {
  const groups: AffixGroup[] = [];
  const byFirst = new Map<string, string[]>();
  const byLast = new Map<string, string[]>();
  for (const parameter of parameters) {
    const words = splitWords(parameter);
    if (words.length < 2) continue;
    const first = words[0];
    const last = words[words.length - 1];
    if (first) byFirst.set(first, [...(byFirst.get(first) ?? []), parameter]);
    if (last && last !== first) byLast.set(last, [...(byLast.get(last) ?? []), parameter]);
  }
  for (const [affix, names] of byFirst) {
    if (names.length >= 2) groups.push({ affix, kind: "prefix", parameters: names });
  }
  for (const [affix, names] of byLast) {
    if (names.length >= 2) groups.push({ affix, kind: "suffix", parameters: names });
  }
  return groups;
}

function packedObjectSource(
  program: Program,
  fn: FunctionNode,
  source: string,
  parameters: string[],
): string | undefined {
  if (parameters.length === 0) return undefined;
  const names = new Set(parameters);
  let found: string | undefined;
  const nested = nestedFunctionRanges(program, fn);
  new Visitor({
    ObjectExpression(node) {
      if (found !== undefined) return;
      if (!belongsDirectlyToFunction(node, nested)) return;
      const referenced = new Set<string>();
      for (const property of node.properties) {
        if (property.type === "SpreadElement") continue;
        if (property.value.type === "Identifier" && names.has(property.value.name)) {
          referenced.add(property.value.name);
        }
      }
      if (referenced.size >= 2) found = source.slice(node.start, node.end).slice(0, 300);
    },
  }).visit(program);
  return found;
}

function siblingFunctions(program: Program): { name: string; parameters: string[] }[] {
  const result: { name: string; parameters: string[] }[] = [];
  const namesOf = (node: FunctionNode): string[] =>
    node.params.flatMap((parameter) => {
      const name = namedParameter(parameter);
      return name === undefined ? [] : [name];
    });
  new Visitor({
    FunctionDeclaration(node) {
      if (node.id?.name) result.push({ name: node.id.name, parameters: namesOf(node) });
    },
    VariableDeclarator(node) {
      if (node.id.type !== "Identifier") return;
      if (node.init?.type !== "ArrowFunctionExpression" && node.init?.type !== "FunctionExpression") {
        return;
      }
      result.push({ name: node.id.name, parameters: namesOf(node.init) });
    },
  }).visit(program);
  return result;
}

function commonMemberRoot(callArguments: string[]): { root: string; count: number } | undefined {
  const counts = new Map<string, number>();
  for (const argument of callArguments) {
    const match = /^([A-Za-z_$][\w$]*)\.[A-Za-z_$][\w$]*/.exec(argument.trim());
    if (!match?.[1]) continue;
    counts.set(match[1], (counts.get(match[1]) ?? 0) + 1);
  }
  let best: { root: string; count: number } | undefined;
  for (const [root, count] of counts) {
    if (count >= 2 && (!best || count > best.count)) best = { root, count };
  }
  return best;
}

export function buildUnnamedParameterObjectEvidence(
  candidate: Candidate,
  projectFiles: ProjectFile[],
): UnnamedParameterObjectEvidence | undefined {
  if (candidate.kind !== "function") return undefined;
  const owner = projectFiles.find((file) => file.filePath === candidate.filePath);
  if (!owner) return undefined;
  const parsed = parseSync(owner.filePath, owner.source, { range: true });
  if (parsed.errors.some((error) => error.severity === "Error")) return undefined;
  const fn = findDirectFunction(parsed.program, candidate);
  if (!fn) return undefined;
  const name = functionName(parsed.program, fn);
  if (!name) return undefined;
  const parameters = fn.params.flatMap((parameter) => {
    const parameterName = namedParameter(parameter);
    return parameterName === undefined ? [] : [parameterName];
  });
  if (parameters.length < 2) return undefined;

  const parameterSources = fn.params.map((parameter) =>
    owner.source.slice(parameter.start, parameter.end).slice(0, 120),
  );
  const packed = packedObjectSource(parsed.program, fn, owner.source, parameters);
  const names = new Set(parameters);
  const siblingOverlap = siblingFunctions(parsed.program)
    .filter(({ name: sibling }) => sibling !== name)
    .flatMap(({ name: sibling, parameters: other }) => {
      const overlap = other.filter((parameter) => names.has(parameter));
      return overlap.length >= 2 ? [{ name: sibling, overlap }] : [];
    })
    .slice(0, 10);
  const callers = findFunctionCallers(candidate.filePath, name, projectFiles);
  const objectSpreadCalls = callers
    .flatMap(({ filePath, call, line, arguments: callArguments }): ObjectSpreadCall[] => {
      const common = commonMemberRoot(callArguments);
      return common === undefined
        ? []
        : [{ filePath, call, line, commonRoot: common.root, memberArgumentCount: common.count }];
    })
    .slice(0, 10);

  return {
    function: {
      name,
      exported: isFunctionExported(parsed.program, fn, name),
      filePath: candidate.filePath,
      source: candidate.source,
      parameterCount: parameters.length,
      parameters: parameterSources,
    },
    cohesion: {
      sharedAffixGroups: sharedAffixGroups(parameters),
      packsParametersIntoObject: packed !== undefined,
      packedObject: packed ?? null,
    },
    siblingOverlap,
    callers,
    objectSpreadCalls,
  };
}
