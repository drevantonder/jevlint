import { Visitor } from "oxc-parser";
import { parseCached } from "./parse-cache.js";
import type { Candidate, ProjectFile } from "../types.js";
import {
  findDirectFunction,
  findFunctionCallers,
  functionName,
  isFunctionExported,
  moduleImports,
  nestedFunctionRanges,
} from "./repository.js";
import type { FunctionCaller, FunctionNode } from "./repository.js";

export type NameFact = {
  name: string;
  kind: "param" | "local" | "catch-param";
  uses: number;
  line: number;
};

export type MysteriousNameEvidence = {
  function: {
    name: string;
    exported: boolean;
    filePath: string;
    source: string;
    startLine: number;
    endLine: number;
  };
  names: NameFact[];
  imports: string[];
  callers: FunctionCaller[];
};

function lineAt(source: string, offset: number): number {
  let line = 1;
  for (let index = 0; index < offset; index += 1) {
    if (source[index] === "\n") line += 1;
  }
  return line;
}

function paramName(parameter: FunctionNode["params"][number]): string | undefined {
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

function countUses(source: string, name: string): number {
  const matches = source.match(new RegExp(`\\b${name}\\b`, "g"));
  return Math.max((matches?.length ?? 1) - 1, 0);
}

export function buildMysteriousNameEvidence(
  candidate: Candidate,
  projectFiles: ProjectFile[],
): MysteriousNameEvidence | undefined {
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

  const functionSource = owner.source.slice(fn.start, fn.end);
  const names: NameFact[] = [];
  for (const parameter of fn.params) {
    const binding = paramName(parameter);
    if (!binding) continue;
    names.push({
      name: binding,
      kind: "param",
      uses: countUses(functionSource, binding),
      line: lineAt(owner.source, parameter.start),
    });
  }

  new Visitor({
    VariableDeclarator(node) {
      if (!direct(node) || node.id.type !== "Identifier") return;
      names.push({
        name: node.id.name,
        kind: "local",
        uses: countUses(functionSource, node.id.name),
        line: lineAt(owner.source, node.start),
      });
    },
    CatchClause(node) {
      if (!direct(node)) return;
      const param = node.param;
      if (param?.type === "Identifier") {
        names.push({
          name: param.name,
          kind: "catch-param",
          uses: countUses(functionSource, param.name),
          line: lineAt(owner.source, param.start),
        });
      }
    },
  }).visit(parsed.program);

  return {
    function: {
      name,
      exported: isFunctionExported(parsed.program, fn, name),
      filePath: candidate.filePath,
      source: candidate.source,
      startLine: lineAt(owner.source, fn.start),
      endLine: lineAt(owner.source, fn.end),
    },
    names: names.slice(0, 25),
    imports: moduleImports(parsed.program).map(({ local }) => local).slice(0, 25),
    callers: findFunctionCallers(candidate.filePath, name, projectFiles),
  };
}
