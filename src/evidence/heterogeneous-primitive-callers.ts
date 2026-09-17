import { parseSync } from "oxc-parser";
import type { ParamPattern } from "oxc-parser";
import type { Candidate, ProjectFile } from "../types.js";
import {
  findDirectFunction,
  findFunctionCallers,
  functionName,
  isFunctionExported,
} from "./repository.js";
import type { FunctionCaller, FunctionNode } from "./repository.js";

export type HeterogeneousStem = {
  stem: string;
  calls: string[];
};

export type HeterogeneousPrimitiveCallersEvidence = {
  function: {
    name: string;
    exported: boolean;
    filePath: string;
    source: string;
    moduleSource: string;
  };
  parameter: {
    index: number;
    name: string;
    source: string;
  };
  stems: HeterogeneousStem[];
  callers: FunctionCaller[];
};

const BARE_PRIMITIVE = /:\s*(string|number|boolean)\s*(?:=.+)?$/s;

const GENERIC_LEAF = new Set([
  "id",
  "key",
  "value",
  "val",
  "data",
  "item",
  "arg",
  "argument",
  "param",
  "result",
  "input",
  "output",
]);

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

function headWord(name: string): string {
  const word = name.split(/(?=[A-Z0-9])|_/).filter(Boolean)[0] ?? name;
  return word.toLowerCase();
}

function argumentStem(argument: string): string | undefined {
  const root = /^([A-Za-z_$][\w$]*(?:\.[A-Za-z_$][\w$]*)*)/.exec(argument.trim())?.[1];
  if (!root) return undefined;
  const segments = root.split(".");
  const first = segments[0];
  const last = segments.at(-1);
  if (!first || !last) return undefined;
  const leaf = headWord(last);
  if (GENERIC_LEAF.has(leaf)) return headWord(first);
  return leaf;
}

export function buildHeterogeneousPrimitiveCallersEvidence(
  candidate: Candidate,
  projectFiles: ProjectFile[],
): HeterogeneousPrimitiveCallersEvidence | undefined {
  if (candidate.kind !== "function") return undefined;
  const owner = projectFiles.find(({ filePath }) => filePath === candidate.filePath);
  if (!owner) return undefined;
  const parsed = parseSync(owner.filePath, owner.source, { range: true });
  if (parsed.errors.some(({ severity }) => severity === "Error")) return undefined;
  const fn: FunctionNode | undefined = findDirectFunction(parsed.program, candidate);
  if (!fn) return undefined;
  const name = functionName(parsed.program, fn);
  if (!name || !isFunctionExported(parsed.program, fn, name)) return undefined;

  const bare: { index: number; name: string; source: string }[] = [];
  const primitiveCounts = new Map<string, number>();
  for (const [index, parameter] of fn.params.entries()) {
    const parameterSource = owner.source.slice(parameter.start, parameter.end);
    const parameterIdentifier = parameterName(parameter);
    const primitive = BARE_PRIMITIVE.exec(parameterSource.trim())?.[1];
    if (!parameterIdentifier || !primitive) continue;
    primitiveCounts.set(primitive, (primitiveCounts.get(primitive) ?? 0) + 1);
    bare.push({ index, name: parameterIdentifier, source: parameterSource });
  }
  if (bare.length === 0) return undefined;
  if ([...primitiveCounts.values()].some((count) => count >= 2)) return undefined;

  const callers = findFunctionCallers(owner.filePath, name, projectFiles);
  if (callers.length < 2) return undefined;

  for (const parameter of bare) {
    const stems = new Map<string, string[]>();
    for (const caller of callers) {
      const argument = caller.arguments[parameter.index];
      if (argument === undefined) continue;
      const stem = argumentStem(argument);
      if (!stem) continue;
      const calls = stems.get(stem) ?? [];
      if (calls.length < 5) calls.push(caller.call.slice(0, 160));
      stems.set(stem, calls);
    }
    if (stems.size < 2) continue;
    return {
      function: {
        name,
        exported: true,
        filePath: owner.filePath,
        source: candidate.source,
        moduleSource: owner.source.slice(0, 16_000),
      },
      parameter,
      stems: [...stems.entries()].map(([stem, calls]) => ({ stem, calls })),
      callers,
    };
  }

  return undefined;
}
