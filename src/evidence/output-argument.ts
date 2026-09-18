import { Visitor } from "oxc-parser";
import { parseCached } from "./parse-cache.js";
import type { AssignmentTarget, Expression } from "oxc-parser";
import type { Candidate, ProjectFile } from "../types.js";
import {
  findDirectFunction,
  findFunctionCallers,
  functionName,
  isFunctionExported,
} from "./repository.js";
import type { FunctionCaller, FunctionNode } from "./repository.js";

type OutputWriteKind = "assignment" | "update" | "delete" | "mutating-call" | "object-assign";

type OutputWrite = {
  parameter: string;
  kind: OutputWriteKind;
  operation: string;
};

export type OutputArgumentEvidence = {
  function: {
    name: string;
    exported: boolean;
    filePath: string;
    source: string;
    moduleSource: string;
    parameters: string[];
  };
  outputWrites: OutputWrite[];
  returns: {
    hasValueReturn: boolean;
    valueReturns: string[];
    bareReturns: string[];
  };
  callers: FunctionCaller[];
};

type SourceRange = {
  start: number;
  end: number;
};

const MUTATING_METHODS = new Set([
  "add",
  "clear",
  "copyWithin",
  "delete",
  "fill",
  "pop",
  "push",
  "reverse",
  "set",
  "shift",
  "sort",
  "splice",
  "unshift",
]);

function rootIdentifier(target: AssignmentTarget | Expression): string | undefined {
  if (target.type === "Identifier") return target.name;
  if (target.type === "MemberExpression") {
    return target.object.type === "Super" ? undefined : rootIdentifier(target.object);
  }
  if (target.type === "ChainExpression") return rootIdentifier(target.expression);
  if (
    target.type === "TSAsExpression"
    || target.type === "TSNonNullExpression"
    || target.type === "TSSatisfiesExpression"
    || target.type === "TSTypeAssertion"
  ) return rootIdentifier(target.expression);
  return undefined;
}

function memberName(expression: Expression): string | undefined {
  if (expression.type !== "MemberExpression" || expression.computed) return undefined;
  return expression.property.type === "Identifier" ? expression.property.name : undefined;
}

function directParameters(fn: FunctionNode, source: string): Map<string, string> {
  const result = new Map<string, string>();
  for (const parameter of fn.params) {
    if (parameter.type === "Identifier") {
      result.set(parameter.name, source.slice(parameter.start, parameter.end));
    } else if (parameter.type === "RestElement" && parameter.argument.type === "Identifier") {
      result.set(parameter.argument.name, source.slice(parameter.start, parameter.end));
    }
  }
  return result;
}

function nestedFunctionRanges(candidate: Candidate, program: Parameters<Visitor["visit"]>[0]): SourceRange[] {
  const ranges: SourceRange[] = [];
  const add = (node: SourceRange): void => {
    if (node.start > candidate.start && node.end < candidate.end) ranges.push(node);
  };
  new Visitor({
    ArrowFunctionExpression: add,
    FunctionDeclaration: add,
    FunctionExpression: add,
  }).visit(program);
  return ranges;
}

function isDirectOperation(node: SourceRange, nested: SourceRange[]): boolean {
  return !nested.some((range) => range.start <= node.start && range.end >= node.end);
}

function parameterFor(
  expression: AssignmentTarget | Expression,
  parameters: Map<string, string>,
): string | undefined {
  const root = rootIdentifier(expression);
  return root && parameters.has(root) ? root : undefined;
}

export function buildOutputArgumentEvidence(
  candidate: Candidate,
  projectFiles: ProjectFile[],
): OutputArgumentEvidence | undefined {
  if (candidate.kind !== "function") return undefined;
  const owner = projectFiles.find((file) => file.filePath === candidate.filePath);
  if (!owner) return undefined;
  const parsed = parseCached(owner.filePath, owner.source);
  if (parsed.errors.some((error) => error.severity === "Error")) return undefined;
  const fn = findDirectFunction(parsed.program, candidate);
  if (!fn) return undefined;
  const name = functionName(parsed.program, fn);
  if (!name) return undefined;
  const parameters = directParameters(fn, owner.source);
  if (parameters.size === 0) return undefined;
  const nested = nestedFunctionRanges(candidate, parsed.program);
  const writes: Array<OutputWrite & SourceRange> = [];
  const valueReturns: Array<SourceRange & { source: string }> = [];
  const bareReturns: Array<SourceRange & { source: string }> = [];

  new Visitor({
    AssignmentExpression(node) {
      if (!isDirectOperation(node, nested)) return;
      const parameter = parameterFor(node.left, parameters);
      if (!parameter || node.left.type !== "MemberExpression") return;
      writes.push({
        parameter,
        kind: node.operator === "=" ? "assignment" : "update",
        operation: owner.source.slice(node.start, node.end),
        start: node.start,
        end: node.end,
      });
    },
    UpdateExpression(node) {
      if (!isDirectOperation(node, nested)) return;
      const parameter = parameterFor(node.argument, parameters);
      if (!parameter || node.argument.type !== "MemberExpression") return;
      writes.push({
        parameter,
        kind: "update",
        operation: owner.source.slice(node.start, node.end),
        start: node.start,
        end: node.end,
      });
    },
    UnaryExpression(node) {
      if (node.operator !== "delete" || !isDirectOperation(node, nested)) return;
      const parameter = parameterFor(node.argument, parameters);
      if (!parameter || node.argument.type !== "MemberExpression") return;
      writes.push({
        parameter,
        kind: "delete",
        operation: owner.source.slice(node.start, node.end),
        start: node.start,
        end: node.end,
      });
    },
    CallExpression(node) {
      if (!isDirectOperation(node, nested)) return;
      if (node.callee.type !== "MemberExpression") return;
      const method = memberName(node.callee);
      if (!method) return;
      if (method === "assign" && rootIdentifier(node.callee.object) === "Object") {
        const target = node.arguments[0];
        if (target && target.type !== "SpreadElement") {
          const parameter = parameterFor(target, parameters);
          if (parameter) {
            writes.push({
              parameter,
              kind: "object-assign",
              operation: owner.source.slice(node.start, node.end),
              start: node.start,
              end: node.end,
            });
          }
        }
        return;
      }
      if (!MUTATING_METHODS.has(method)) return;
      const parameter = parameterFor(node.callee.object, parameters);
      if (!parameter) return;
      writes.push({
        parameter,
        kind: "mutating-call",
        operation: owner.source.slice(node.start, node.end),
        start: node.start,
        end: node.end,
      });
    },
    ReturnStatement(node) {
      if (!isDirectOperation(node, nested)) return;
      const source = owner.source.slice(node.start, node.end);
      if (node.argument) {
        valueReturns.push({ source, start: node.start, end: node.end });
      } else {
        bareReturns.push({ source, start: node.start, end: node.end });
      }
    },
  }).visit(parsed.program);

  if (writes.length === 0) return undefined;
  writes.sort((left, right) => left.start - right.start);
  return {
    function: {
      name,
      exported: isFunctionExported(parsed.program, fn, name),
      filePath: owner.filePath,
      source: candidate.source,
      moduleSource: owner.source.slice(0, 16_000),
      parameters: [...parameters.values()],
    },
    outputWrites: writes.map(({ parameter, kind, operation }) => ({ parameter, kind, operation })),
    returns: {
      hasValueReturn: valueReturns.length > 0,
      valueReturns: valueReturns.map(({ source }) => source),
      bareReturns: bareReturns.map(({ source }) => source),
    },
    callers: findFunctionCallers(candidate.filePath, name, projectFiles),
  };
}
