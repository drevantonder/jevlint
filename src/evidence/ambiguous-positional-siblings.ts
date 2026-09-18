import { Visitor } from "oxc-parser";
import { parseCached } from "./parse-cache.js";
import type { Candidate, ProjectFile } from "../types.js";
import {
  findDirectFunction,
  findFunctionCallers,
  functionName,
  isFunctionExported,
} from "./repository.js";
import type { FunctionCaller, FunctionNode } from "./repository.js";

export type SwappablePair = {
  first: string;
  second: string;
  sharedType: string;
  explicitType: boolean;
  conventionalOrder: boolean;
};

export type PositionalCall = {
  filePath: string;
  line: number;
  call: string;
  firstArgument: string;
  secondArgument: string;
  sameKind: boolean;
};

export type AmbiguousPositionalSiblingsEvidence = {
  function: {
    name: string;
    exported: boolean;
    parameterCount: number;
    parameters: string[];
    filePath: string;
    source: string;
  };
  pairs: SwappablePair[];
  calls: PositionalCall[];
  callSummary: {
    total: number;
    withObjectArgument: number;
  };
  callers: FunctionCaller[];
};

const MAX_CALLS = 8;
const MAX_EXCERPT_CHARS = 240;

const CONVENTIONAL_PAIRS = new Set([
  "start/end",
  "min/max",
  "begin/end",
  "first/last",
  "from/to",
  "low/high",
  "old/new",
  "left/right",
  "top/bottom",
]);

function lineAt(source: string, offset: number): number {
  let line = 1;
  for (let index = 0; index < offset; index += 1) {
    if (source[index] === "\n") line += 1;
  }
  return line;
}

function bindingName(parameter: FunctionNode["params"][number]): string | undefined {
  const value = parameter.type === "TSParameterProperty" ? parameter.parameter : parameter;
  if (value.type === "Identifier") return value.name;
  if (value.type === "AssignmentPattern" && value.left.type === "Identifier") {
    return value.left.name;
  }
  return undefined;
}

function isOptionsBag(parameter: FunctionNode["params"][number]): boolean {
  const value = parameter.type === "TSParameterProperty" ? parameter.parameter : parameter;
  return value.type === "ObjectPattern"
    || (value.type === "AssignmentPattern" && value.left.type === "ObjectPattern");
}

function typeText(source: string, parameter: FunctionNode["params"][number]): string | undefined {
  const text = source.slice(parameter.start, parameter.end);
  const match = /:\s*(.+?)\s*(=\s*.+)?$/.exec(text);
  return match?.[1]?.trim();
}

function argumentKind(argument: { type: string }): string {
  if (argument.type === "Literal") return "literal";
  if (argument.type === "Identifier") return "identifier";
  if (argument.type === "MemberExpression" || argument.type === "ChainExpression") return "member";
  if (argument.type === "CallExpression" || argument.type === "NewExpression") return "call";
  if (argument.type === "ObjectExpression") return "object";
  if (argument.type === "ArrayExpression") return "array";
  if (argument.type === "TemplateLiteral") return "template";
  return "other";
}

export function buildAmbiguousPositionalSiblingsEvidence(
  candidate: Candidate,
  projectFiles: ProjectFile[],
): AmbiguousPositionalSiblingsEvidence | undefined {
  if (candidate.kind !== "function") return undefined;
  const owner = projectFiles.find((file) => file.filePath === candidate.filePath);
  if (!owner) return undefined;
  const parsed = parseCached(owner.filePath, owner.source);
  if (parsed.errors.some((error) => error.severity === "Error")) return undefined;
  const fn = findDirectFunction(parsed.program, candidate);
  if (!fn) return undefined;
  const name = functionName(parsed.program, fn);
  if (!name) return undefined;
  if (fn.params.length < 2) return undefined;

  const names = fn.params.map(bindingName);
  const kinds = fn.params.map((parameter) => {
    if (isOptionsBag(parameter)) return undefined;
    if (parameter.type === "RestElement") return undefined;
    const explicit = typeText(owner.source, parameter);
    if (explicit !== undefined) return { kind: explicit.replace(/\s+/g, " "), explicit: true };
    return { kind: "untyped", explicit: false };
  });

  const pairs: SwappablePair[] = [];
  for (let index = 0; index + 1 < fn.params.length; index += 1) {
    const first = names[index];
    const second = names[index + 1];
    const firstKind = kinds[index];
    const secondKind = kinds[index + 1];
    if (!first || !second || !firstKind || !secondKind) continue;
    if (firstKind.kind !== secondKind.kind) continue;
    // Optional/defaulted trailing parameters grow the list rather than confusing order.
    const firstParam = fn.params[index];
    if (!firstParam) continue;
    const firstText = owner.source.slice(firstParam.start, firstParam.end);
    if (firstText.includes("?") || /=\s*.+$/.test(firstText)) continue;
    pairs.push({
      first,
      second,
      sharedType: firstKind.kind,
      explicitType: firstKind.explicit,
      conventionalOrder: CONVENTIONAL_PAIRS.has(`${first.toLowerCase()}/${second.toLowerCase()}`),
    });
  }
  if (pairs.length === 0) return undefined;

  const callers = findFunctionCallers(owner.filePath, name, projectFiles);
  if (callers.length === 0) return undefined;

  const calls: PositionalCall[] = [];
  let withObjectArgument = 0;
  const seen = new Set<string>();
  for (const caller of callers) {
    const file = projectFiles.find(({ filePath }) => filePath === caller.filePath);
    if (!file) continue;
    const callerParsed = parseCached(file.filePath, file.source);
    if (callerParsed.errors.some((error) => error.severity === "Error")) continue;
    new Visitor({
      CallExpression(node) {
        const text = file.source.slice(node.start, node.end);
        if (text !== caller.call || seen.has(`${caller.filePath}:${caller.line}`)) return;
        seen.add(`${caller.filePath}:${caller.line}`);
        for (const pair of pairs) {
          const firstIndex = names.findIndex((entry) => entry === pair.first);
          const firstArgument = node.arguments[firstIndex];
          const secondArgument = node.arguments[firstIndex + 1];
          if (!firstArgument || !secondArgument) continue;
          if (firstArgument.type === "SpreadElement" || secondArgument.type === "SpreadElement") continue;
          if (firstArgument.type === "ObjectExpression" || secondArgument.type === "ObjectExpression") {
            withObjectArgument += 1;
            continue;
          }
          if (calls.length < MAX_CALLS) {
            calls.push({
              filePath: caller.filePath,
              line: lineAt(file.source, node.start),
              call: text.slice(0, MAX_EXCERPT_CHARS),
              firstArgument: file.source.slice(firstArgument.start, firstArgument.end).slice(0, 120),
              secondArgument: file.source.slice(secondArgument.start, secondArgument.end).slice(0, 120),
              sameKind: argumentKind(firstArgument) === argumentKind(secondArgument),
            });
          }
        }
      },
    }).visit(callerParsed.program);
  }

  if (calls.length === 0 && withObjectArgument === 0) return undefined;

  const parameters = fn.params.map((parameter) => owner.source.slice(parameter.start, parameter.end).slice(0, 120));
  return {
    function: {
      name,
      exported: isFunctionExported(parsed.program, fn, name),
      parameterCount: fn.params.length,
      parameters,
      filePath: owner.filePath,
      source: candidate.source,
    },
    pairs,
    calls,
    callSummary: {
      total: callers.length,
      withObjectArgument,
    },
    callers,
  };
}
