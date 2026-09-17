import { parseSync } from "oxc-parser";
import type { Program } from "oxc-parser";
import {
  findDirectFunction,
  findFunctionCallersWithCoverage,
  functionName,
  isFunctionExported,
} from "./repository.js";
import type { FunctionCaller, FunctionNode } from "./repository.js";
import type { Candidate, ProjectFile } from "../types.js";

const MAX_SIBLINGS = 6;
const MAX_EXCERPT_CHARS = 500;

type TrailingExtension = {
  name: string;
  kind: "optional" | "defaulted" | "boolean";
  source: string;
};

export type OptionsBagSibling = {
  name: string;
  optionsParameter: string;
  excerpt: string;
};

export type PositionalExtensionDriftEvidence = {
  function: {
    name: string;
    exported: boolean;
    filePath: string;
    source: string;
  };
  extension: {
    totalPositional: number;
    trailing: TrailingExtension[];
  };
  siblingsWithOptionsBag: OptionsBagSibling[];
  callers: FunctionCaller[];
  callSummary: {
    total: number;
    withUndefinedPlaceholder: number;
    distinctArgumentCounts: number[];
  };
};

type ParameterFlags = {
  name: string;
  source: string;
  rest: boolean;
  optionsBag: boolean;
  optional: boolean;
  defaulted: boolean;
  booleanTyped: boolean;
};

function parameterFlags(
  parameter: FunctionNode["params"][number],
  source: string,
): ParameterFlags | undefined {
  const value = parameter.type === "TSParameterProperty" ? parameter.parameter : parameter;
  const text = source.slice(parameter.start, parameter.end);
  if (value.type === "RestElement") {
    const name = value.argument.type === "Identifier" ? value.argument.name : "rest";
    return {
      name,
      source: text,
      rest: true,
      optionsBag: false,
      optional: false,
      defaulted: false,
      booleanTyped: false,
    };
  }
  if (value.type === "ObjectPattern" || value.type === "ArrayPattern") {
    return {
      name: "destructured",
      source: text,
      rest: false,
      optionsBag: value.type === "ObjectPattern",
      optional: false,
      defaulted: value.type === "ArrayPattern" ? false : value.type === "ObjectPattern" && text.includes("="),
      booleanTyped: false,
    };
  }
  if (value.type === "AssignmentPattern") {
    if (value.left.type !== "Identifier") {
      if (value.left.type === "ObjectPattern") {
        return {
          name: "options",
          source: text,
          rest: false,
          optionsBag: true,
          optional: false,
          defaulted: true,
          booleanTyped: false,
        };
      }
      return undefined;
    }
    return {
      name: value.left.name,
      source: text,
      rest: false,
      optionsBag: false,
      optional: false,
      defaulted: true,
      booleanTyped: /:\s*boolean\b/.test(text),
    };
  }
  if (value.type !== "Identifier") return undefined;
  const optional = /\?\s*:/.test(text) || /\?\s*$/.test(text);
  const annotation = text.includes("=") ? text.slice(0, text.indexOf("=")) : text;
  const objectTyped = /:\s*\{/.test(annotation);
  return {
    name: value.name,
    source: text,
    rest: false,
    optionsBag: objectTyped,
    optional: objectTyped ? false : optional,
    defaulted: false,
    booleanTyped: objectTyped ? false : /:\s*boolean\b/.test(text),
  };
}

function moduleOptionsBagSiblings(
  program: Program,
  source: string,
  exclude: string,
): OptionsBagSibling[] {
  const siblings: OptionsBagSibling[] = [];
  for (const statement of program.body) {
    if (siblings.length >= MAX_SIBLINGS) break;
    const exported = statement.type === "ExportNamedDeclaration";
    const declaration = exported ? statement.declaration : statement;
    const entries: { name: string; node: FunctionNode }[] = [];
    if (declaration?.type === "FunctionDeclaration" && declaration.id) {
      entries.push({ name: declaration.id.name, node: declaration });
    } else if (declaration?.type === "VariableDeclaration") {
      for (const item of declaration.declarations) {
        if (item.id.type !== "Identifier" || !item.init) continue;
        if (
          item.init.type === "ArrowFunctionExpression"
          || item.init.type === "FunctionExpression"
        ) entries.push({ name: item.id.name, node: item.init });
      }
    }
    for (const { name, node } of entries) {
      if (name === exclude || siblings.length >= MAX_SIBLINGS) continue;
      const flags = node.params.map((parameter) => parameterFlags(parameter, source));
      const bag = flags.find((flag) => flag?.optionsBag);
      if (!bag?.name) continue;
      siblings.push({
        name,
        optionsParameter: bag.source.slice(0, 200),
        excerpt: source.slice(node.start, node.end).slice(0, MAX_EXCERPT_CHARS),
      });
    }
  }
  return siblings;
}

export function buildPositionalExtensionDriftEvidence(
  candidate: Candidate,
  projectFiles: ProjectFile[],
): PositionalExtensionDriftEvidence | undefined {
  if (candidate.kind !== "function") return undefined;
  const owner = projectFiles.find((file) => file.filePath === candidate.filePath);
  if (!owner) return undefined;
  const parsed = parseSync(owner.filePath, owner.source, { range: true });
  if (parsed.errors.some((error) => error.severity === "Error")) return undefined;
  const fn = findDirectFunction(parsed.program, candidate);
  if (!fn) return undefined;
  const name = functionName(parsed.program, fn);
  if (!name) return undefined;

  const flags = fn.params.map((parameter) => parameterFlags(parameter, owner.source));
  const positional = flags.filter((flag) => flag && !flag.rest && !flag.optionsBag);
  const trailing: TrailingExtension[] = [];
  for (let index = positional.length - 1; index >= 0; index -= 1) {
    const flag = positional[index];
    if (!flag) break;
    if (flag.defaulted) trailing.unshift({ name: flag.name, kind: "defaulted", source: flag.source });
    else if (flag.optional) trailing.unshift({ name: flag.name, kind: "optional", source: flag.source });
    else if (flag.booleanTyped) trailing.unshift({ name: flag.name, kind: "boolean", source: flag.source });
    else break;
  }
  if (trailing.length === 0) return undefined;

  const siblings = moduleOptionsBagSiblings(parsed.program, owner.source, name);
  if (siblings.length === 0) return undefined;

  const coverage = findFunctionCallersWithCoverage(candidate.filePath, name, projectFiles);
  return {
    function: {
      name,
      exported: isFunctionExported(parsed.program, fn, name),
      filePath: candidate.filePath,
      source: candidate.source,
    },
    extension: {
      totalPositional: positional.length,
      trailing,
    },
    siblingsWithOptionsBag: siblings,
    callers: coverage.callers.slice(0, 20),
    callSummary: {
      total: coverage.total,
      withUndefinedPlaceholder: coverage.callers.filter((caller) =>
        caller.arguments.some((argument) => argument.trim() === "undefined")
      ).length,
      distinctArgumentCounts: [...new Set(coverage.callers.map((caller) => caller.arguments.length))]
        .sort((a, b) => a - b).slice(0, 10),
    },
  };
}
