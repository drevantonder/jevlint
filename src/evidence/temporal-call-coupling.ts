import { parseSync, Visitor } from "oxc-parser";
import type { Program } from "oxc-parser";
import type { Candidate, ProjectFile } from "../types.js";
import {
  findDirectFunction,
  findFunctionCallers,
  functionName,
  isFunctionExported,
} from "./repository.js";
import type { FunctionCaller, FunctionNode } from "./repository.js";

type WriterEvidence = {
  name: string;
  exported: boolean;
  source: string;
  callers: FunctionCaller[];
};

type SharedStateEvidence = {
  binding: string;
  declaration: string;
  setupSuggestingWriter: boolean;
  guardPresent: boolean;
  writers: WriterEvidence[];
};

export type TemporalCallCouplingEvidence = {
  function: {
    name: string;
    exported: boolean;
    filePath: string;
    source: string;
  };
  sharedState: SharedStateEvidence[];
  callers: FunctionCaller[];
  readerAloneCallers: FunctionCaller[];
};

const SETUP_NAME_PATTERN = /^(init|initialize|configure|setup|connect|open|start|boot|prepare|register)([A-Z_]|$)/;

function moduleMutableBindings(program: Program, source: string): { name: string; declaration: string }[] {
  const result: { name: string; declaration: string }[] = [];
  for (const statement of program.body) {
    const declaration = statement.type === "ExportNamedDeclaration"
      ? statement.declaration
      : statement;
    if (!declaration || declaration.type !== "VariableDeclaration") continue;
    if (declaration.kind !== "let" && declaration.kind !== "var") continue;
    for (const item of declaration.declarations) {
      if (item.id.type !== "Identifier") continue;
      result.push({
        name: item.id.name,
        declaration: source.slice(declaration.start, declaration.end),
      });
    }
  }
  return result;
}

function isDirect(node: FunctionNode, target: FunctionNode): boolean {
  return node.start === target.start && node.end === target.end;
}

function localNames(program: Program, fn: FunctionNode): Set<string> {
  const names = new Set<string>();
  for (const parameter of fn.params) {
    const value = parameter.type === "TSParameterProperty" ? parameter.parameter : parameter;
    if (value.type === "Identifier") names.add(value.name);
    else if (value.type === "AssignmentPattern" && value.left.type === "Identifier") {
      names.add(value.left.name);
    } else if (value.type === "RestElement" && value.argument.type === "Identifier") {
      names.add(value.argument.name);
    }
  }
  let depth = 0;
  const enter = (node: FunctionNode): void => {
    if (isDirect(node, fn)) depth = 1;
    else if (depth > 0) depth += 1;
  };
  const exit = (node: FunctionNode): void => {
    if (depth === 0) return;
    depth -= 1;
    if (isDirect(node, fn)) depth = 0;
  };
  new Visitor({
    ArrowFunctionExpression: enter,
    "ArrowFunctionExpression:exit": exit,
    FunctionDeclaration: enter,
    "FunctionDeclaration:exit": exit,
    FunctionExpression: enter,
    "FunctionExpression:exit": exit,
    VariableDeclaration(node) {
      if (depth !== 1) return;
      for (const item of node.declarations) {
        if (item.id.type === "Identifier") names.add(item.id.name);
      }
    },
  }).visit(program);
  return names;
}

function identifiersReadByFunction(
  program: Program,
  fn: FunctionNode,
  bindingNames: Set<string>,
  locals: Set<string>,
): Set<string> {
  const read = new Set<string>();
  let depth = 0;
  const enter = (node: FunctionNode): void => {
    if (isDirect(node, fn)) depth = 1;
    else if (depth > 0) depth += 1;
  };
  const exit = (node: FunctionNode): void => {
    if (depth === 0) return;
    depth -= 1;
    if (isDirect(node, fn)) depth = 0;
  };
  new Visitor({
    ArrowFunctionExpression: enter,
    "ArrowFunctionExpression:exit": exit,
    FunctionDeclaration: enter,
    "FunctionDeclaration:exit": exit,
    FunctionExpression: enter,
    "FunctionExpression:exit": exit,
    AssignmentExpression(node) {
      if (depth === 1 && node.left.type === "Identifier" && node.operator === "=") {
        locals.add(node.left.name);
      }
    },
    Identifier(node) {
      if (depth === 1 && bindingNames.has(node.name) && !locals.has(node.name)) {
        read.add(node.name);
      }
    },
  }).visit(program);
  for (const name of locals) read.delete(name);
  return read;
}

function moduleFunctions(program: Program): FunctionNode[] {
  const result: FunctionNode[] = [];
  for (const statement of program.body) {
    const declaration = statement.type === "ExportNamedDeclaration"
      ? statement.declaration
      : statement;
    if (declaration?.type === "FunctionDeclaration") {
      result.push(declaration);
      continue;
    }
    if (declaration?.type === "VariableDeclaration") {
      for (const item of declaration.declarations) {
        if (
          item.init?.type === "ArrowFunctionExpression"
          || item.init?.type === "FunctionExpression"
        ) result.push(item.init);
      }
    }
  }
  if (result.length === 0) {
    new Visitor({
      ArrowFunctionExpression(node) {
        result.push(node);
      },
      FunctionDeclaration(node) {
        result.push(node);
      },
      FunctionExpression(node) {
        result.push(node);
      },
    }).visit(program);
  }
  return result;
}

function assignsBinding(program: Program, fn: FunctionNode, binding: string): boolean {
  let found = false;
  let depth = 0;
  const enter = (node: FunctionNode): void => {
    if (isDirect(node, fn)) depth = 1;
    else if (depth > 0) depth += 1;
  };
  const exit = (node: FunctionNode): void => {
    if (depth === 0) return;
    depth -= 1;
    if (isDirect(node, fn)) depth = 0;
  };
  new Visitor({
    ArrowFunctionExpression: enter,
    "ArrowFunctionExpression:exit": exit,
    FunctionDeclaration: enter,
    "FunctionDeclaration:exit": exit,
    FunctionExpression: enter,
    "FunctionExpression:exit": exit,
    AssignmentExpression(node) {
      if (depth !== 1) return;
      if (node.left.type === "Identifier" && node.left.name === binding) found = true;
    },
  }).visit(program);
  return found;
}

export function buildTemporalCallCouplingEvidence(
  candidate: Candidate,
  projectFiles: ProjectFile[],
): TemporalCallCouplingEvidence | undefined {
  if (candidate.kind !== "function") return undefined;
  const owner = projectFiles.find((file) => file.filePath === candidate.filePath);
  if (!owner) return undefined;
  const parsed = parseSync(owner.filePath, owner.source, { range: true });
  if (parsed.errors.some((error) => error.severity === "Error")) return undefined;
  const fn = findDirectFunction(parsed.program, candidate);
  if (!fn) return undefined;
  const name = functionName(parsed.program, fn);
  if (!name) return undefined;

  const bindings = moduleMutableBindings(parsed.program, owner.source);
  if (bindings.length === 0) return undefined;
  const bindingNames = new Set(bindings.map(({ name: binding }) => binding));
  const locals = localNames(parsed.program, fn);
  const read = identifiersReadByFunction(parsed.program, fn, bindingNames, locals);
  if (read.size === 0) return undefined;

  const guardPresent = candidate.source.includes("throw");
  const sharedState: SharedStateEvidence[] = [];
  for (const binding of bindings) {
    if (!read.has(binding.name)) continue;
    const writers = moduleFunctions(parsed.program)
      .filter((other) => !isDirect(other, fn) && assignsBinding(parsed.program, other, binding.name))
      .flatMap((node): WriterEvidence[] => {
        const writerName = functionName(parsed.program, node);
        if (!writerName) return [];
        return [{
          name: writerName,
          exported: isFunctionExported(parsed.program, node, writerName),
          source: owner.source.slice(node.start, node.end).slice(0, 2_000),
          callers: findFunctionCallers(owner.filePath, writerName, projectFiles),
        }];
      });
    if (writers.length === 0) continue;
    sharedState.push({
      binding: binding.name,
      declaration: binding.declaration,
      setupSuggestingWriter: writers.some(({ name: writerName }) => SETUP_NAME_PATTERN.test(writerName)),
      guardPresent,
      writers: writers.slice(0, 8),
    });
  }
  if (sharedState.length === 0) return undefined;

  const callers = findFunctionCallers(candidate.filePath, name, projectFiles);
  const writerCallerFiles = new Set(
    sharedState.flatMap(({ writers }) => writers.flatMap(({ callers: writerCallers }) =>
      writerCallers.map(({ filePath }) => filePath)
    )),
  );
  const readerAloneCallers = callers.filter(({ filePath }) => !writerCallerFiles.has(filePath));

  return {
    function: {
      name,
      exported: isFunctionExported(parsed.program, fn, name),
      filePath: candidate.filePath,
      source: candidate.source,
    },
    sharedState,
    callers,
    readerAloneCallers: readerAloneCallers.slice(0, 20),
  };
}
