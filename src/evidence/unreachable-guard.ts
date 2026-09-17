import { parseSync, Visitor } from "oxc-parser";
import type { Expression, IfStatement } from "oxc-parser";
import type { Candidate, ProjectFile } from "../types.js";
import { belongsDirectlyToFunction, nestedFunctionRanges } from "./function-scope.js";
import {
  findDirectFunction,
  findFunctionCallers,
  functionName,
  isFunctionExported,
} from "./repository.js";
import type { FunctionCaller, FunctionNode } from "./repository.js";

export type GuardKind = "nullish" | "typeof" | "instanceof" | "truthiness";

export type UnreachableGuard = {
  source: string;
  line: number;
  guardedParameter: string;
  guardKind: GuardKind;
  parameterIndex: number;
  fallback: string | null;
};

export type UnreachableGuardEvidence = {
  function: {
    name: string;
    exported: boolean;
    filePath: string;
    source: string;
    parameters: string[];
  };
  guards: UnreachableGuard[];
  callers: FunctionCaller[];
  crossModuleCallerCount: number;
};

function lineAt(source: string, offset: number): number {
  let line = 1;
  for (let index = 0; index < offset; index += 1) {
    if (source[index] === "\n") line += 1;
  }
  return line;
}

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

function testReferences(test: Expression, name: string, source: string): boolean {
  return new RegExp(`\\b${name}\\b`).test(source.slice(test.start, test.end));
}

function guardKindOf(test: Expression, name: string, source: string): GuardKind | undefined {
  const text = source.slice(test.start, test.end);
  if (!testReferences(test, name, source)) return undefined;
  if (test.type === "UnaryExpression" && test.operator === "typeof") return "typeof";
  if (
    test.type === "BinaryExpression"
    && (test.operator === "===" || test.operator === "!==")
    && text.includes("typeof")
  ) return "typeof";
  if (test.type === "BinaryExpression" && (test.operator === "==" || test.operator === "!=")) {
    return "nullish";
  }
  if (
    test.type === "BinaryExpression"
    && (test.operator === "===" || test.operator === "!==")
    && /\bnull\b|\bundefined\b/.test(text)
  ) return "nullish";
  if (test.type === "BinaryExpression" && test.operator === "instanceof") return "instanceof";
  if (test.type === "UnaryExpression" && test.operator === "!") return "truthiness";
  if (test.type === "UnaryExpression" && test.operator === "void") return "nullish";
  if (test.type === "LogicalExpression") return "truthiness";
  return undefined;
}

function exitsEarly(node: IfStatement, source: string): string | undefined {
  const branch = node.consequent;
  if (branch.type === "ReturnStatement" || branch.type === "ThrowStatement") {
    return source.slice(branch.start, branch.end).slice(0, 200);
  }
  if (branch.type !== "BlockStatement" || branch.body.length === 0) return undefined;
  const first = branch.body[0];
  if (first?.type === "ReturnStatement" || first?.type === "ThrowStatement") {
    return source.slice(first.start, first.end).slice(0, 200);
  }
  return undefined;
}

export function buildUnreachableGuardEvidence(
  candidate: Candidate,
  projectFiles: ProjectFile[],
): UnreachableGuardEvidence | undefined {
  if (candidate.kind !== "function") return undefined;
  const owner = projectFiles.find((file) => file.filePath === candidate.filePath);
  if (!owner) return undefined;
  const parsed = parseSync(owner.filePath, owner.source, { range: true });
  if (parsed.errors.some((error) => error.severity === "Error")) return undefined;
  const fn = findDirectFunction(parsed.program, candidate);
  if (!fn) return undefined;
  const name = functionName(parsed.program, fn);
  if (!name) return undefined;
  const parameters = fn.params.map(namedParameter);
  if (parameters.every((parameter) => parameter === undefined)) return undefined;

  const nested = nestedFunctionRanges(parsed.program, fn);
  const guards: UnreachableGuard[] = [];
  new Visitor({
    IfStatement(node) {
      if (!belongsDirectlyToFunction(node, nested)) return;
      if (node.start < candidate.start || node.end > candidate.end) return;
      const fallback = exitsEarly(node, owner.source);
      if (fallback === undefined) return;
      parameters.forEach((parameter, index) => {
        if (parameter === undefined) return;
        const kind = guardKindOf(node.test, parameter, owner.source);
        if (kind === undefined) return;
        guards.push({
          source: owner.source.slice(node.start, node.end).slice(0, 300),
          line: lineAt(owner.source, node.start),
          guardedParameter: parameter,
          guardKind: kind,
          parameterIndex: index,
          fallback,
        });
      });
    },
  }).visit(parsed.program);
  if (guards.length === 0) return undefined;

  const callers = findFunctionCallers(candidate.filePath, name, projectFiles);
  return {
    function: {
      name,
      exported: isFunctionExported(parsed.program, fn, name),
      filePath: candidate.filePath,
      source: candidate.source,
      parameters: parameters.map((parameter) => parameter ?? "<pattern>"),
    },
    guards: guards.slice(0, 10),
    callers,
    crossModuleCallerCount: callers.filter(({ filePath }) => filePath !== candidate.filePath).length,
  };
}
