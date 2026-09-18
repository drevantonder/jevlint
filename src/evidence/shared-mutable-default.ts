import { Visitor } from "oxc-parser";
import { parseCached } from "./parse-cache.js";
import type { AssignmentExpression, CallExpression, Expression, Node } from "oxc-parser";
import {
  belongsDirectlyToFunction,
  containsNode,
  nestedFunctionRanges,
} from "./function-scope.js";
import type { NodeRange } from "./function-scope.js";
import {
  findDirectFunction,
  findFunctionCallers,
  functionName,
  isFunctionExported,
} from "./repository.js";
import type { FunctionCaller, FunctionNode } from "./repository.js";
import type { Candidate, ProjectFile } from "../types.js";

const MAX_DEFAULTS = 4;
const MAX_WRITES_PER_DEFAULT = 6;
const MAX_CALLER_SAMPLES = 6;

const MUTATING_METHODS = new Set([
  "push",
  "pop",
  "shift",
  "unshift",
  "splice",
  "sort",
  "reverse",
  "fill",
  "set",
  "add",
  "delete",
  "clear",
]);

export type MutableDefault = {
  name: string;
  index: number;
  defaultSource: string;
  defaultKind: "object-literal" | "array-literal" | "shared-reference";
  writes: string[];
  clonedBeforeWrite: boolean;
  callersOmittingArgument: number;
};

export type SharedMutableDefaultEvidence = {
  function: {
    name: string | null;
    exported: boolean;
    filePath: string;
    source: string;
  };
  defaults: MutableDefault[];
  repository: {
    callers: FunctionCaller[];
  };
};

function nodeSource(node: Node, source: string): string {
  return source.slice(node.start, node.end);
}

function assignmentRoot(target: AssignmentExpression["left"] | Expression): string | undefined {
  if (target.type === "Identifier") return target.name;
  if (target.type === "MemberExpression") return assignmentRoot(target.object);
  if (target.type === "ChainExpression") return assignmentRoot(target.expression);
  if (
    target.type === "TSAsExpression"
    || target.type === "TSNonNullExpression"
    || target.type === "TSSatisfiesExpression"
    || target.type === "TSTypeAssertion"
  ) return assignmentRoot(target.expression);
  return undefined;
}

function writeExcerpts(
  fn: FunctionNode,
  binding: string,
  program: Parameters<typeof nestedFunctionRanges>[0],
  source: string,
  nested: NodeRange[],
): string[] {
  const excerpts: string[] = [];
  new Visitor({
    AssignmentExpression(node) {
      if (excerpts.length >= MAX_WRITES_PER_DEFAULT) return;
      if (!containsNode(fn, node) || !belongsDirectlyToFunction(node, nested)) return;
      if (assignmentRoot(node.left) === binding) excerpts.push(nodeSource(node, source));
    },
    UpdateExpression(node) {
      if (excerpts.length >= MAX_WRITES_PER_DEFAULT) return;
      if (!containsNode(fn, node) || !belongsDirectlyToFunction(node, nested)) return;
      if (node.argument.type === "Identifier" && node.argument.name === binding) {
        excerpts.push(nodeSource(node, source));
      }
    },
    CallExpression(call: CallExpression) {
      if (excerpts.length >= MAX_WRITES_PER_DEFAULT) return;
      if (!containsNode(fn, call) || !belongsDirectlyToFunction(call, nested)) return;
      const callee = call.callee;
      if (
        callee.type === "MemberExpression"
        && callee.object.type === "Identifier"
        && callee.object.name === binding
        && callee.property.type === "Identifier"
        && MUTATING_METHODS.has(callee.property.name)
      ) {
        excerpts.push(nodeSource(call, source));
        return;
      }
      if (callee.type === "MemberExpression" && callee.property.type === "Identifier") {
        const objectText = nodeSource(callee.object, source);
        const [target] = call.arguments;
        if (
          objectText === "Object"
          && callee.property.name === "assign"
          && target?.type === "Identifier"
          && target.name === binding
        ) excerpts.push(nodeSource(call, source));
      }
    },
  }).visit(program);
  return excerpts;
}

function clonedBeforeWrite(fn: FunctionNode, binding: string, source: string): boolean {
  if (!fn.body) return false;
  const body = source.slice(fn.body.start, fn.body.end);
  const clone = new RegExp(
    `\\{\\s*\\.\\.\\.\\s*${binding}\\b|\\[\\s*\\.\\.\\.\\s*${binding}\\b|structuredClone\\s*\\(\\s*${binding}\\b|Array\\.from\\s*\\(\\s*${binding}\\b|${binding}\\b\\s*\\.slice\\s*\\(\\s*\\)|Object\\.assign\\s*\\(\\s*\\{\\}`,
  );
  return clone.test(body);
}

export function buildSharedMutableDefaultEvidence(
  candidate: Candidate,
  projectFiles: ProjectFile[],
): SharedMutableDefaultEvidence | undefined {
  if (candidate.kind !== "function") return undefined;
  const owner = projectFiles.find((file) => file.filePath === candidate.filePath);
  if (!owner) return undefined;
  const parsed = parseCached(owner.filePath, owner.source);
  if (parsed.errors.some((error) => error.severity === "Error")) return undefined;
  const fn = findDirectFunction(parsed.program, candidate);
  if (!fn) return undefined;

  const nested = nestedFunctionRanges(parsed.program, fn);
  const name = functionName(parsed.program, fn);
  const callers = name ? findFunctionCallers(candidate.filePath, name, projectFiles) : [];
  const defaults: MutableDefault[] = [];

  fn.params.forEach((parameter, index) => {
    if (defaults.length >= MAX_DEFAULTS) return;
    const value = parameter.type === "TSParameterProperty" ? parameter.parameter : parameter;
    if (value.type !== "AssignmentPattern" || value.left.type !== "Identifier") return;
    const binding = value.left.name;
    const defaultKind = value.right.type === "ObjectExpression"
      ? "object-literal"
      : value.right.type === "ArrayExpression"
        ? "array-literal"
        : value.right.type === "Identifier" || value.right.type === "MemberExpression"
          ? "shared-reference"
          : undefined;
    if (!defaultKind) return;
    const writes = writeExcerpts(fn, binding, parsed.program, owner.source, nested);
    if (writes.length === 0) return;
    defaults.push({
      name: binding,
      index,
      defaultSource: nodeSource(value.right, owner.source).slice(0, 200),
      defaultKind,
      writes,
      clonedBeforeWrite: clonedBeforeWrite(fn, binding, owner.source),
      callersOmittingArgument: callers.filter((caller) => caller.arguments.length <= index).length,
    });
  });

  if (defaults.length === 0) return undefined;
  return {
    function: {
      name: name ?? null,
      exported: name ? isFunctionExported(parsed.program, fn, name) : false,
      filePath: candidate.filePath,
      source: candidate.source,
    },
    defaults,
    repository: {
      callers: callers.slice(0, MAX_CALLER_SAMPLES),
    },
  };
}
