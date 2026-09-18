import { Visitor } from "oxc-parser";
import { parseCached } from "./parse-cache.js";
import type { AssignmentTarget, CallExpression, Expression } from "oxc-parser";
import type { Candidate, ProjectFile } from "../types.js";
import {
  findDirectFunction,
  findFunctionCallers,
  functionName,
  isFunctionExported,
  moduleImports,
  resolveModule,
} from "./repository.js";
import type { FunctionCaller, FunctionNode } from "./repository.js";

type SourceRange = {
  start: number;
  end: number;
};

type EffectTarget = {
  root: string | null;
  importedFrom: string | null;
  ownership: "project-module" | "external-package" | "same-module" | "unresolved";
  targetModule: { filePath: string; source: string } | null;
};

type SideEffect = {
  kind: "ignored-call" | "assignment" | "update" | "delete";
  operation: string;
  target: EffectTarget;
};

type ReturnEvidence = {
  expression: string;
};

export type QuerySideEffectEvidence = {
  function: {
    name: string;
    exported: boolean;
    filePath: string;
    source: string;
    moduleSource: string;
  };
  returns: ReturnEvidence[];
  sideEffects: SideEffect[];
  callers: FunctionCaller[];
};

const LOCAL_MUTATING_METHODS = new Set([
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

function isDirect(node: SourceRange, candidate: Candidate, nested: SourceRange[]): boolean {
  return node.start >= candidate.start
    && node.end <= candidate.end
    && !nested.some((range) => range.start <= node.start && range.end >= node.end);
}

function parameterNames(fn: FunctionNode): Set<string> {
  const result = new Set<string>();
  for (const parameter of fn.params) {
    if (parameter.type === "Identifier") result.add(parameter.name);
    if (parameter.type === "RestElement" && parameter.argument.type === "Identifier") {
      result.add(parameter.argument.name);
    }
  }
  return result;
}

function callExpression(expression: Expression): CallExpression | undefined {
  if (expression.type === "CallExpression") return expression;
  if (expression.type === "AwaitExpression" && expression.argument.type === "CallExpression") {
    return expression.argument;
  }
  if (expression.type === "ChainExpression" && expression.expression.type === "CallExpression") {
    return expression.expression;
  }
  return undefined;
}

function targetEvidence(
  root: string | undefined,
  owner: ProjectFile,
  imports: ReturnType<typeof moduleImports>,
  projectFiles: ProjectFile[],
): EffectTarget {
  const imported = root ? imports.find(({ local }) => local === root) : undefined;
  const targetModule = imported
    ? resolveModule(owner.filePath, imported.source, projectFiles)
    : undefined;
  return {
    root: root ?? null,
    importedFrom: imported?.source ?? null,
    ownership: imported
      ? imported.source.startsWith(".") ? "project-module" : "external-package"
      : root ? "same-module" : "unresolved",
    targetModule: targetModule
      ? { filePath: targetModule.filePath, source: targetModule.source.slice(0, 12_000) }
      : null,
  };
}

export function buildQuerySideEffectEvidence(
  candidate: Candidate,
  projectFiles: ProjectFile[],
): QuerySideEffectEvidence | undefined {
  if (candidate.kind !== "function") return undefined;
  const owner = projectFiles.find((file) => file.filePath === candidate.filePath);
  if (!owner) return undefined;
  const parsed = parseCached(owner.filePath, owner.source);
  if (parsed.errors.some((error) => error.severity === "Error")) return undefined;
  const fn = findDirectFunction(parsed.program, candidate);
  if (!fn) return undefined;
  const name = functionName(parsed.program, fn);
  if (!name) return undefined;

  const nested = nestedFunctionRanges(candidate, parsed.program);
  const parameters = parameterNames(fn);
  const locals = new Set<string>();
  const returns: Array<ReturnEvidence & SourceRange> = [];
  const effects: Array<SideEffect & SourceRange> = [];
  const imports = moduleImports(parsed.program);

  new Visitor({
    VariableDeclarator(node) {
      if (isDirect(node, candidate, nested) && node.id.type === "Identifier") {
        locals.add(node.id.name);
      }
    },
  }).visit(parsed.program);

  new Visitor({
    ReturnStatement(node) {
      if (!node.argument || !isDirect(node, candidate, nested)) return;
      returns.push({
        expression: owner.source.slice(node.argument.start, node.argument.end),
        start: node.start,
        end: node.end,
      });
    },
    ExpressionStatement(node) {
      if (!isDirect(node, candidate, nested)) return;
      const call = callExpression(node.expression);
      if (!call) return;
      const root = rootIdentifier(call.callee);
      const method = memberName(call.callee);
      if (root && locals.has(root) && method && LOCAL_MUTATING_METHODS.has(method)) return;
      effects.push({
        kind: "ignored-call",
        operation: owner.source.slice(call.start, call.end),
        target: targetEvidence(root, owner, imports, projectFiles),
        start: node.start,
        end: node.end,
      });
    },
    AssignmentExpression(node) {
      if (!isDirect(node, candidate, nested) || node.left.type !== "MemberExpression") return;
      const root = rootIdentifier(node.left);
      if (!root || parameters.has(root) || locals.has(root)) return;
      effects.push({
        kind: node.operator === "=" ? "assignment" : "update",
        operation: owner.source.slice(node.start, node.end),
        target: targetEvidence(root, owner, imports, projectFiles),
        start: node.start,
        end: node.end,
      });
    },
    UpdateExpression(node) {
      if (!isDirect(node, candidate, nested) || node.argument.type !== "MemberExpression") return;
      const root = rootIdentifier(node.argument);
      if (!root || parameters.has(root) || locals.has(root)) return;
      effects.push({
        kind: "update",
        operation: owner.source.slice(node.start, node.end),
        target: targetEvidence(root, owner, imports, projectFiles),
        start: node.start,
        end: node.end,
      });
    },
    UnaryExpression(node) {
      if (
        node.operator !== "delete"
        || !isDirect(node, candidate, nested)
        || node.argument.type !== "MemberExpression"
      ) return;
      const root = rootIdentifier(node.argument);
      if (!root || parameters.has(root) || locals.has(root)) return;
      effects.push({
        kind: "delete",
        operation: owner.source.slice(node.start, node.end),
        target: targetEvidence(root, owner, imports, projectFiles),
        start: node.start,
        end: node.end,
      });
    },
  }).visit(parsed.program);

  if (returns.length === 0 || effects.length === 0) return undefined;
  returns.sort((left, right) => left.start - right.start);
  effects.sort((left, right) => left.start - right.start);
  return {
    function: {
      name,
      exported: isFunctionExported(parsed.program, fn, name),
      filePath: owner.filePath,
      source: candidate.source,
      moduleSource: owner.source.slice(0, 16_000),
    },
    returns: returns.map(({ expression }) => ({ expression })),
    sideEffects: effects.map(({ kind, operation, target }) => ({ kind, operation, target })),
    callers: findFunctionCallers(candidate.filePath, name, projectFiles),
  };
}
