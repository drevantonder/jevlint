import { Visitor } from "oxc-parser";
import { parseCached } from "./parse-cache.js";
import type { CallExpression, Expression, MemberExpression } from "oxc-parser";
import type { Candidate, ProjectFile } from "../types.js";
import { isCompositionRootEntry } from "./composition-root.js";
import {
  findDirectFunction,
  findFunctionCallers,
  functionName,
  isFunctionExported,
} from "./repository.js";
import type { FunctionCaller, FunctionNode } from "./repository.js";

export type AmbientAccessKind = "singleton" | "locator" | "context-store";

export type AmbientAccess = {
  expression: string;
  kind: AmbientAccessKind;
  root: string;
};

export type AmbientDependencyGrabEvidence = {
  function: {
    name: string | null;
    exported: boolean;
    filePath: string;
    source: string;
    parameters: string[];
  };
  accesses: AmbientAccess[];
  callers: FunctionCaller[];
};

const SINGLETON_CALL = new Set([
  "getInstance",
  "getSharedInstance",
  "sharedInstance",
  "defaultInstance",
  "getDefaultInstance",
  "shared",
  "getShared",
]);

const SINGLETON_READ = new Set(["shared", "current", "instance"]);

const LOCATOR_METHOD = new Set(["resolve", "lookup", "get", "make", "require"]);

const LOCATOR_RECEIVER = /container|registry|locator|injector|providers?|services|resolver|scope|context$/i;

const CONTEXT_STORE_CALL = new Set(["getStore", "getContext", "getNamespace"]);

function memberName(expression: MemberExpression): string | undefined {
  if (!expression.computed && expression.property.type === "Identifier") {
    return expression.property.name;
  }
  return undefined;
}

function rootIdentifier(expression: Expression): string | undefined {
  if (expression.type === "Identifier") return expression.name;
  if (expression.type === "MemberExpression") return rootIdentifier(expression.object);
  if (expression.type === "ChainExpression") return rootIdentifier(expression.expression);
  return undefined;
}

function parameterNames(fn: FunctionNode): string[] {
  const names: string[] = [];
  for (const parameter of fn.params) {
    const value = parameter.type === "TSParameterProperty" ? parameter.parameter : parameter;
    if (value.type === "Identifier") names.push(value.name);
    else if (value.type === "AssignmentPattern" && value.left.type === "Identifier") {
      names.push(value.left.name);
    } else if (value.type === "RestElement" && value.argument.type === "Identifier") {
      names.push(value.argument.name);
    }
  }
  return names;
}

function parameterSources(fn: FunctionNode, source: string): string[] {
  return fn.params.map((parameter) => source.slice(parameter.start, parameter.end).slice(0, 160));
}

export function buildAmbientDependencyGrabEvidence(
  candidate: Candidate,
  projectFiles: ProjectFile[],
): AmbientDependencyGrabEvidence | undefined {
  if (candidate.kind !== "function") return undefined;
  const owner = projectFiles.find((file) => file.filePath === candidate.filePath);
  if (!owner) return undefined;
  const parsed = parseCached(owner.filePath, owner.source);
  if (parsed.errors.some((error) => error.severity === "Error")) return undefined;
  const fn = findDirectFunction(parsed.program, candidate);
  if (!fn) return undefined;

  const shadowed = new Set(parameterNames(fn));
  let functionDepth = 0;
  const isDirect = (node: FunctionNode): boolean => node.start === fn.start && node.end === fn.end;
  const enterFunction = (node: FunctionNode): void => {
    if (isDirect(node)) functionDepth = 1;
    else if (functionDepth > 0) functionDepth += 1;
  };
  const exitFunction = (node: FunctionNode): void => {
    if (functionDepth === 0) return;
    functionDepth -= 1;
    if (isDirect(node)) functionDepth = 0;
  };

  new Visitor({
    ArrowFunctionExpression: enterFunction,
    "ArrowFunctionExpression:exit": exitFunction,
    FunctionDeclaration: enterFunction,
    "FunctionDeclaration:exit": exitFunction,
    FunctionExpression: enterFunction,
    "FunctionExpression:exit": exitFunction,
    VariableDeclarator(node) {
      if (functionDepth !== 1 || node.id.type !== "Identifier") return;
      shadowed.add(node.id.name);
    },
  }).visit(parsed.program);

  const accesses: AmbientAccess[] = [];
  const callRanges: { start: number; end: number }[] = [];
  const seen = new Set<string>();

  const record = (
    node: { start: number; end: number },
    kind: AmbientAccessKind,
    root: string,
  ): void => {
    if (shadowed.has(root)) return;
    const expression = owner.source.slice(node.start, node.end).slice(0, 240);
    const key = `${kind}:${expression}`;
    if (seen.has(key)) return;
    seen.add(key);
    accesses.push({ expression, kind, root });
    if (accesses.length <= 20) callRanges.push({ start: node.start, end: node.end });
  };

  const enterCallScope = (node: FunctionNode): void => {
    if (isDirect(node)) functionDepth = 1;
    else if (functionDepth > 0) functionDepth += 1;
  };
  const exitCallScope = (node: FunctionNode): void => {
    if (functionDepth === 0) return;
    functionDepth -= 1;
    if (isDirect(node)) functionDepth = 0;
  };
  functionDepth = 0;

  const calleeMember = (call: CallExpression): MemberExpression | undefined =>
    call.callee.type === "MemberExpression" ? call.callee : undefined;

  new Visitor({
    ArrowFunctionExpression: enterCallScope,
    "ArrowFunctionExpression:exit": exitCallScope,
    FunctionDeclaration: enterCallScope,
    "FunctionDeclaration:exit": exitCallScope,
    FunctionExpression: enterCallScope,
    "FunctionExpression:exit": exitCallScope,
    CallExpression(call) {
      if (functionDepth !== 1) return;
      const member = calleeMember(call);
      if (!member) return;
      const name = memberName(member);
      if (!name) return;
      const root = rootIdentifier(member.object);
      if (!root) return;
      if (SINGLETON_CALL.has(name)) {
        record(call, "singleton", root);
      } else if (CONTEXT_STORE_CALL.has(name)) {
        record(call, "context-store", root);
      } else if (LOCATOR_METHOD.has(name) && LOCATOR_RECEIVER.test(root)) {
        record(call, "locator", root);
      }
    },
    MemberExpression(node) {
      if (functionDepth !== 1) return;
      if (callRanges.some((range) => range.start <= node.start && range.end >= node.end)) return;
      const name = memberName(node);
      if (!name || !SINGLETON_READ.has(name)) return;
      const root = rootIdentifier(node.object);
      if (!root || root[0] !== root[0]?.toUpperCase()) return;
      record(node, "singleton", root);
    },
  }).visit(parsed.program);

  if (accesses.length === 0) return undefined;

  const name = functionName(parsed.program, fn);
  const callers = name ? findFunctionCallers(candidate.filePath, name, projectFiles) : [];
  if (
    isCompositionRootEntry({
      name: name ?? null,
      params: parameterSources(fn, owner.source),
      exported: name ? isFunctionExported(parsed.program, fn, name) : false,
      callers,
      moduleSource: owner.source,
      functionSource: candidate.source,
    })
  ) {
    return undefined;
  }
  return {
    function: {
      name: name ?? null,
      exported: name ? isFunctionExported(parsed.program, fn, name) : false,
      filePath: candidate.filePath,
      source: candidate.source,
      parameters: parameterSources(fn, owner.source),
    },
    accesses: accesses.slice(0, 10),
    callers,
  };
}
