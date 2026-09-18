import { Visitor } from "oxc-parser";
import { parseCached } from "./parse-cache.js";
import type { Candidate, ProjectFile } from "../types.js";
import {
  findDirectFunction,
  findFunctionCallers,
  functionName,
  isFunctionExported,
  nestedFunctionRanges,
} from "./repository.js";
import type { FunctionCaller, FunctionNode } from "./repository.js";

export type AbbreviatedIdentifier = {
  name: string;
  kind: "function" | "parameter" | "local";
  suspectSegments: string[];
  expandedTermsPresent: string[];
  source: string;
};

export type CrypticAbbreviationEvidence = {
  function: {
    name: string;
    exported: boolean;
    filePath: string;
    source: string;
  };
  identifiers: AbbreviatedIdentifier[];
  segmentCounts: {
    total: number;
    dictionaryLike: number;
  };
  moduleContext: string;
  callers: FunctionCaller[];
};

const OVER_COMPRESSED = new Map<string, string[]>([
  ["usr", ["user", "users"]],
  ["acct", ["account", "accounts"]],
  ["calc", ["calculat"]],
  ["cfg", ["config"]],
  ["mgr", ["manager"]],
  ["bal", ["balance"]],
]);

const VOWELS = /[aeiou]/i;

function segmentsOf(name: string): string[] {
  return name
    .split(/(?=[A-Z])|_|-/u)
    .map((segment) => segment.toLowerCase())
    .filter((segment) => segment.length > 0);
}

function isSuspect(segment: string): boolean {
  if (OVER_COMPRESSED.has(segment)) return true;
  if (segment.length < 4) return false;
  return !VOWELS.test(segment);
}

function expandedTerms(segment: string, moduleLower: string): string[] {
  const expansions = OVER_COMPRESSED.get(segment) ?? [];
  return expansions.filter((term) => moduleLower.includes(term));
}

function bindingName(parameter: FunctionNode["params"][number]): string | undefined {
  const value = parameter.type === "TSParameterProperty" ? parameter.parameter : parameter;
  if (value.type === "AssignmentPattern" && value.left.type === "Identifier") {
    return value.left.name;
  }
  if (value.type === "RestElement" && value.argument.type === "Identifier") {
    return value.argument.name;
  }
  if (value.type !== "Identifier") return undefined;
  return value.name;
}

export function buildCrypticAbbreviationEvidence(
  candidate: Candidate,
  projectFiles: ProjectFile[],
): CrypticAbbreviationEvidence | undefined {
  if (candidate.kind !== "function") return undefined;
  const owner = projectFiles.find((file) => file.filePath === candidate.filePath);
  if (!owner) return undefined;
  const parsed = parseCached(owner.filePath, owner.source);
  if (parsed.errors.some((error) => error.severity === "Error")) return undefined;
  const fn = findDirectFunction(parsed.program, candidate);
  if (!fn) return undefined;
  const name = functionName(parsed.program, fn);
  if (!name) return undefined;

  const nested = nestedFunctionRanges(parsed.program, candidate);
  const direct = (node: { start: number; end: number }): boolean =>
    node.start >= candidate.start
    && node.end <= candidate.end
    && !nested.some((range) => range.start <= node.start && range.end >= node.end);

  const moduleLower = owner.source.toLowerCase();
  const seen = new Map<string, AbbreviatedIdentifier>();
  let total = 0;
  let dictionaryLike = 0;

  const examine = (
    identifier: string,
    kind: AbbreviatedIdentifier["kind"],
    source: string,
  ): void => {
    if (seen.has(`${kind}:${identifier}`)) return;
    const segments = segmentsOf(identifier);
    total += segments.length;
    dictionaryLike += segments.filter((segment) => VOWELS.test(segment)).length;
    const suspectSegments = segments.filter(isSuspect);
    if (suspectSegments.length === 0) return;
    seen.set(`${kind}:${identifier}`, {
      name: identifier,
      kind,
      suspectSegments,
      expandedTermsPresent: [
        ...new Set(suspectSegments.flatMap((segment) => expandedTerms(segment, moduleLower))),
      ],
      source: source.slice(0, 300),
    });
  };

  examine(name, "function", owner.source.slice(fn.start, fn.end));
  for (const parameter of fn.params) {
    const paramName = bindingName(parameter);
    if (!paramName) continue;
    examine(paramName, "parameter", owner.source.slice(parameter.start, parameter.end));
  }
  new Visitor({
    VariableDeclarator(node) {
      if (!direct(node) || node.id.type !== "Identifier") return;
      examine(node.id.name, "local", owner.source.slice(node.start, node.end));
    },
  }).visit(parsed.program);

  const identifiers = [...seen.values()];
  if (identifiers.length === 0) return undefined;

  return {
    function: {
      name,
      exported: isFunctionExported(parsed.program, fn, name),
      filePath: owner.filePath,
      source: candidate.source,
    },
    identifiers,
    segmentCounts: { total, dictionaryLike },
    moduleContext: owner.source.slice(0, 8000),
    callers: findFunctionCallers(owner.filePath, name, projectFiles),
  };
}
