import { Visitor } from "oxc-parser";
import { parseCached } from "./parse-cache.js";
import type { Program } from "oxc-parser";
import type { Candidate, ProjectFile } from "../types.js";
import { containsNode, nestedFunctionRanges } from "./function-scope.js";
import {
  findDirectFunction,
  findFunctionCallers,
  functionName,
  isFunctionExported,
} from "./repository.js";
import type { FunctionCaller, FunctionNode } from "./repository.js";

export type LazySharedState = {
  binding: string;
  declaration: string;
  guard: string;
  assignment: string;
  readers: string[];
  resetOrInspectExport: string | null;
};

export type SinglyOwnedLazySharedStateEvidence = {
  function: {
    name: string | null;
    exported: boolean;
    filePath: string;
    source: string;
  };
  sharedStates: LazySharedState[];
  callers: FunctionCaller[];
};

type ModuleBinding = {
  name: string;
  declaration: string;
};

type ModuleFunction = {
  name: string;
  node: FunctionNode;
  exported: boolean;
};

function moduleInitializedBindings(program: Program, source: string): ModuleBinding[] {
  const bindings: ModuleBinding[] = [];
  for (const statement of program.body) {
    const declaration = statement.type === "ExportNamedDeclaration"
      ? statement.declaration
      : statement;
    if (declaration?.type !== "VariableDeclaration") continue;
    if (declaration.kind !== "let" && declaration.kind !== "var") continue;
    for (const item of declaration.declarations) {
      if (item.id.type !== "Identifier" || !item.init) continue;
      bindings.push({
        name: item.id.name,
        declaration: source.slice(declaration.start, declaration.end),
      });
    }
  }
  return bindings;
}

function moduleFunctions(program: Program): ModuleFunction[] {
  const functions: ModuleFunction[] = [];
  for (const statement of program.body) {
    const exported = statement.type === "ExportNamedDeclaration";
    const declaration = exported ? statement.declaration : statement;
    if (declaration?.type === "FunctionDeclaration" && declaration.id) {
      functions.push({ name: declaration.id.name, node: declaration, exported });
      continue;
    }
    if (declaration?.type !== "VariableDeclaration") continue;
    for (const item of declaration.declarations) {
      if (item.id.type !== "Identifier" || !item.init) continue;
      if (
        item.init.type === "ArrowFunctionExpression"
        || item.init.type === "FunctionExpression"
      ) {
        functions.push({ name: item.id.name, node: item.init, exported });
      }
    }
  }
  return functions;
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

function mentionsBinding(source: string, binding: string): boolean {
  return new RegExp(`\\b${binding}\\b`).test(source);
}

function lazyWrites(
  program: Program,
  fn: FunctionNode,
  binding: string,
  source: string,
): { guard: string; assignment: string }[] {
  const nested = nestedFunctionRanges(program, fn);
  const result: { guard: string; assignment: string }[] = [];
  const guardStack: string[] = [];
  new Visitor({
    IfStatement(node) {
      if (!containsNode(fn, node) || nested.some((range) => containsNode(range, node))) return;
      guardStack.push(containsNode(fn, node.test) ? source.slice(node.test.start, node.test.end) : "");
    },
    "IfStatement:exit"(node) {
      if (!containsNode(fn, node) || nested.some((range) => containsNode(range, node))) return;
      guardStack.pop();
    },
    AssignmentExpression(node) {
      if (!containsNode(fn, node) || nested.some((range) => containsNode(range, node))) return;
      if (node.left.type !== "Identifier" || node.left.name !== binding) return;
      if (node.operator === "??=" || node.operator === "||=") {
        result.push({
          guard: source.slice(node.start, node.end),
          assignment: source.slice(node.start, node.end),
        });
        return;
      }
      if (node.operator !== "=") return;
      const guard = guardStack.at(-1);
      if (guard && mentionsBinding(guard, binding)) {
        result.push({ guard, assignment: source.slice(node.start, node.end) });
      }
    },
  }).visit(program);
  return result.slice(0, 5);
}

function writesInOtherFunction(
  program: Program,
  fn: ModuleFunction,
  binding: string,
  source: string,
): string[] {
  if (parameterNames(fn.node).includes(binding)) return [];
  const nested = nestedFunctionRanges(program, fn.node);
  const excerpts: string[] = [];
  new Visitor({
    AssignmentExpression(node) {
      if (!containsNode(fn.node, node)) return;
      if (nested.some((range) => containsNode(range, node))) return;
      if (node.left.type === "Identifier" && node.left.name === binding) {
        excerpts.push(source.slice(node.start, node.end));
      }
    },
    UpdateExpression(node) {
      if (!containsNode(fn.node, node)) return;
      if (nested.some((range) => containsNode(range, node))) return;
      if (node.argument.type === "Identifier" && node.argument.name === binding) {
        excerpts.push(source.slice(node.start, node.end));
      }
    },
  }).visit(program);
  return excerpts;
}

function readsInFunction(program: Program, fn: FunctionNode, binding: string): boolean {
  if (parameterNames(fn).includes(binding)) return false;
  const nested = nestedFunctionRanges(program, fn);
  let found = false;
  new Visitor({
    Identifier(node) {
      if (found || !containsNode(fn, node)) return;
      if (nested.some((range) => containsNode(range, node))) return;
      if (node.name === binding) found = true;
    },
  }).visit(program);
  return found;
}

function resetOrInspect(
  program: Program,
  fn: ModuleFunction,
  binding: string,
  source: string,
): string | null {
  if (!fn.exported || parameterNames(fn.node).includes(binding)) return null;
  const nested = nestedFunctionRanges(program, fn.node);
  let result: string | null = null;
  new Visitor({
    ReturnStatement(node) {
      if (result || !node.argument || !containsNode(fn.node, node)) return;
      if (nested.some((range) => containsNode(range, node))) return;
      const text = source.slice(node.argument.start, node.argument.end);
      if (text === binding || text.startsWith(`${binding}.`) || text.startsWith(`${binding}[`)) {
        result = `inspects shared state: ${source.slice(node.start, node.end)}`;
      }
    },
    AssignmentExpression(node) {
      if (result || !containsNode(fn.node, node)) return;
      if (nested.some((range) => containsNode(range, node))) return;
      if (node.left.type !== "Identifier" || node.left.name !== binding) return;
      if (/^(\[\]|\{\}|null|undefined|0|""|'')$/.test(source.slice(node.right.start, node.right.end).trim())) {
        result = `resets shared state: ${source.slice(node.start, node.end)}`;
      }
    },
  }).visit(program);
  return result;
}

export function buildSinglyOwnedLazySharedStateEvidence(
  candidate: Candidate,
  projectFiles: ProjectFile[],
): SinglyOwnedLazySharedStateEvidence | undefined {
  if (candidate.kind !== "function") return undefined;
  const owner = projectFiles.find((file) => file.filePath === candidate.filePath);
  if (!owner) return undefined;
  const parsed = parseCached(owner.filePath, owner.source);
  if (parsed.errors.some((error) => error.severity === "Error")) return undefined;
  const fn = findDirectFunction(parsed.program, candidate);
  if (!fn) return undefined;

  const functions = moduleFunctions(parsed.program);
  const candidateName = functionName(parsed.program, fn);
  const others = functions.filter((item) =>
    !(item.node.start === fn.start && item.node.end === fn.end)
  );

  const sharedStates: LazySharedState[] = [];
  for (const binding of moduleInitializedBindings(parsed.program, owner.source)) {
    if (parameterNames(fn).includes(binding.name)) continue;
    const writes = lazyWrites(parsed.program, fn, binding.name, owner.source);
    if (writes.length === 0) continue;
    const otherWriters = others.filter((item) =>
      writesInOtherFunction(parsed.program, item, binding.name, owner.source).length > 0
    );
    if (otherWriters.length > 0) continue;
    const readers = others
      .filter((item) => readsInFunction(parsed.program, item.node, binding.name))
      .map((item) => item.name);
    const seam = others
      .map((item) => resetOrInspect(parsed.program, item, binding.name, owner.source))
      .find((value): value is string => value !== null) ?? null;
    const first = writes[0];
    if (!first) continue;
    sharedStates.push({
      binding: binding.name,
      declaration: binding.declaration,
      guard: first.guard.slice(0, 240),
      assignment: first.assignment.slice(0, 240),
      readers,
      resetOrInspectExport: seam?.slice(0, 240) ?? null,
    });
  }

  if (sharedStates.length === 0) return undefined;

  return {
    function: {
      name: candidateName ?? null,
      exported: candidateName ? isFunctionExported(parsed.program, fn, candidateName) : false,
      filePath: candidate.filePath,
      source: candidate.source,
    },
    sharedStates,
    callers: candidateName ? findFunctionCallers(candidate.filePath, candidateName, projectFiles) : [],
  };
}
