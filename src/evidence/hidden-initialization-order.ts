import { Visitor } from "oxc-parser";
import { parseCached } from "./parse-cache.js";
import type {
  BindingPattern,
  ParamPattern,
  Program,
  VariableDeclaration,
} from "oxc-parser";
import type { Candidate, ProjectFile } from "../types.js";
import {
  findDirectFunction,
  findFunctionCallers,
  functionName,
  isFunctionExported,
} from "./repository.js";
import type { FunctionCaller, FunctionNode } from "./repository.js";

type MutableBinding = {
  name: string;
  declaration: string;
};

type InitializerEvidence = {
  name: string;
  exported: boolean;
  source: string;
  callers: FunctionCaller[];
};

type InitializationDependency = {
  binding: MutableBinding;
  initializers: InitializerEvidence[];
};

type CallerModule = {
  filePath: string;
  source: string;
};

export type HiddenInitializationOrderEvidence = {
  function: {
    name: string;
    exported: boolean;
    filePath: string;
    source: string;
    moduleSource: string;
  };
  dependencies: InitializationDependency[];
  callers: FunctionCaller[];
  callerModules: CallerModule[];
};

function declarationFromStatement(statement: Program["body"][number]): VariableDeclaration | undefined {
  const declaration = statement.type === "ExportNamedDeclaration"
    ? statement.declaration
    : statement;
  return declaration?.type === "VariableDeclaration" ? declaration : undefined;
}

function uninitializedMutableBindings(program: Program, source: string): MutableBinding[] {
  const bindings: MutableBinding[] = [];
  for (const statement of program.body) {
    const declaration = declarationFromStatement(statement);
    if (!declaration || (declaration.kind !== "let" && declaration.kind !== "var")) continue;
    for (const item of declaration.declarations) {
      if (item.init || item.id.type !== "Identifier") continue;
      bindings.push({
        name: item.id.name,
        declaration: source.slice(declaration.start, declaration.end),
      });
    }
  }
  return bindings;
}

type SourceRange = {
  start: number;
  end: number;
};

type NamedRange = SourceRange & {
  name: string;
};

function isDirectFunction(node: FunctionNode, target: FunctionNode): boolean {
  return node.start === target.start && node.end === target.end;
}

function bindingIdentifiers(pattern: BindingPattern | ParamPattern): NamedRange[] {
  if (pattern.type === "Identifier") {
    return [{ name: pattern.name, start: pattern.start, end: pattern.end }];
  }
  if (pattern.type === "AssignmentPattern") return bindingIdentifiers(pattern.left);
  if (pattern.type === "RestElement") return bindingIdentifiers(pattern.argument);
  if (pattern.type === "TSParameterProperty") return bindingIdentifiers(pattern.parameter);
  if (pattern.type === "ArrayPattern") {
    return pattern.elements.flatMap((element) => element ? bindingIdentifiers(element) : []);
  }
  return pattern.properties.flatMap((property) =>
    property.type === "RestElement"
      ? bindingIdentifiers(property.argument)
      : bindingIdentifiers(property.value),
  );
}

function lexicalShadowRanges(
  program: Program,
  fn: FunctionNode,
  bindingNames: Set<string>,
): NamedRange[] {
  const shadows: NamedRange[] = fn.params
    .flatMap(bindingIdentifiers)
    .filter(({ name }) => bindingNames.has(name))
    .map(({ name }) => ({ name, start: fn.start, end: fn.end }));
  const scopes: SourceRange[] = [];
  let functionDepth = 0;

  const addBindings = (
    pattern: BindingPattern | ParamPattern,
    scope: SourceRange,
  ): void => {
    for (const binding of bindingIdentifiers(pattern)) {
      if (bindingNames.has(binding.name)) shadows.push({ name: binding.name, ...scope });
    }
  };
  const currentScope = (): SourceRange => scopes.at(-1) ?? fn;
  const enterFunction = (node: FunctionNode): void => {
    if (isDirectFunction(node, fn)) {
      functionDepth = 1;
      return;
    }
    if (functionDepth === 1 && node.type === "FunctionDeclaration" && node.id) {
      addBindings(node.id, currentScope());
    }
    if (functionDepth > 0) functionDepth += 1;
  };
  const exitFunction = (node: FunctionNode): void => {
    if (functionDepth === 0) return;
    functionDepth -= 1;
    if (isDirectFunction(node, fn)) functionDepth = 0;
  };
  const enterScope = (node: SourceRange): void => {
    if (functionDepth === 1) scopes.push(node);
  };
  const exitScope = (): void => {
    if (functionDepth === 1) scopes.pop();
  };

  new Visitor({
    ArrowFunctionExpression: enterFunction,
    "ArrowFunctionExpression:exit": exitFunction,
    FunctionDeclaration: enterFunction,
    "FunctionDeclaration:exit": exitFunction,
    FunctionExpression: enterFunction,
    "FunctionExpression:exit": exitFunction,
    BlockStatement: enterScope,
    "BlockStatement:exit": exitScope,
    ForStatement: enterScope,
    "ForStatement:exit": exitScope,
    ForInStatement: enterScope,
    "ForInStatement:exit": exitScope,
    ForOfStatement: enterScope,
    "ForOfStatement:exit": exitScope,
    SwitchStatement: enterScope,
    "SwitchStatement:exit": exitScope,
    VariableDeclaration(node) {
      if (functionDepth !== 1) return;
      const scope = node.kind === "var" ? fn : currentScope();
      for (const declaration of node.declarations) addBindings(declaration.id, scope);
    },
    CatchClause(node) {
      if (functionDepth === 1 && node.param) addBindings(node.param, node);
    },
    ClassDeclaration(node) {
      if (functionDepth === 1 && node.id) addBindings(node.id, currentScope());
    },
  }).visit(program);
  return shadows;
}

function rangeKey(range: SourceRange): string {
  return `${range.start}:${range.end}`;
}

function pureWriteTargets(program: Program, fn: FunctionNode): Set<string> {
  const targets = new Set<string>();
  let functionDepth = 0;
  const enterFunction = (node: FunctionNode): void => {
    if (isDirectFunction(node, fn)) {
      functionDepth = 1;
    } else if (functionDepth > 0) {
      functionDepth += 1;
    }
  };
  const exitFunction = (node: FunctionNode): void => {
    if (functionDepth === 0) return;
    functionDepth -= 1;
    if (isDirectFunction(node, fn)) functionDepth = 0;
  };

  new Visitor({
    ArrowFunctionExpression: enterFunction,
    "ArrowFunctionExpression:exit": exitFunction,
    FunctionDeclaration: enterFunction,
    "FunctionDeclaration:exit": exitFunction,
    FunctionExpression: enterFunction,
    "FunctionExpression:exit": exitFunction,
    AssignmentExpression(node) {
      if (functionDepth === 1 && node.operator === "=" && node.left.type === "Identifier") {
        targets.add(rangeKey(node.left));
      }
    },
  }).visit(program);
  return targets;
}

function isShadowed(name: string, offset: number, shadows: NamedRange[]): boolean {
  return shadows.some((shadow) =>
    shadow.name === name && shadow.start <= offset && shadow.end >= offset,
  );
}

function bindingsReadByFunction(
  program: Program,
  fn: FunctionNode,
  bindings: MutableBinding[],
): Set<string> {
  const available = new Set(bindings.map(({ name }) => name));
  const shadows = lexicalShadowRanges(program, fn, available);
  const writes = pureWriteTargets(program, fn);
  const read = new Set<string>();
  let functionDepth = 0;
  const enterFunction = (node: FunctionNode): void => {
    if (isDirectFunction(node, fn)) {
      functionDepth = 1;
    } else if (functionDepth > 0) {
      functionDepth += 1;
    }
  };
  const exitFunction = (node: FunctionNode): void => {
    if (functionDepth === 0) return;
    functionDepth -= 1;
    if (isDirectFunction(node, fn)) functionDepth = 0;
  };

  new Visitor({
    ArrowFunctionExpression: enterFunction,
    "ArrowFunctionExpression:exit": exitFunction,
    FunctionDeclaration: enterFunction,
    "FunctionDeclaration:exit": exitFunction,
    FunctionExpression: enterFunction,
    "FunctionExpression:exit": exitFunction,
    Identifier(node) {
      if (
        functionDepth === 1
        && available.has(node.name)
        && !writes.has(rangeKey(node))
        && !isShadowed(node.name, node.start, shadows)
      ) read.add(node.name);
    },
  }).visit(program);
  return read;
}

function bindingWriters(
  program: Program,
  bindingNames: Set<string>,
): Map<string, FunctionNode[]> {
  const writers = new Map<string, FunctionNode[]>();
  const functions: FunctionNode[] = [];
  new Visitor({
    ArrowFunctionExpression(node) {
      functions.push(node);
    },
    FunctionDeclaration(node) {
      functions.push(node);
    },
    FunctionExpression(node) {
      functions.push(node);
    },
  }).visit(program);
  const shadows = new Map(functions.map((fn) => [
    rangeKey(fn),
    lexicalShadowRanges(program, fn, bindingNames),
  ]));
  const functionStack: FunctionNode[] = [];
  const enterFunction = (node: FunctionNode): void => {
    functionStack.push(node);
  };
  const exitFunction = (): void => {
    functionStack.pop();
  };

  new Visitor({
    ArrowFunctionExpression: enterFunction,
    "ArrowFunctionExpression:exit": exitFunction,
    FunctionDeclaration: enterFunction,
    "FunctionDeclaration:exit": exitFunction,
    FunctionExpression: enterFunction,
    "FunctionExpression:exit": exitFunction,
    AssignmentExpression(node) {
      if (node.left.type !== "Identifier" || !bindingNames.has(node.left.name)) return;
      const writer = functionStack.at(-1);
      if (!writer || isShadowed(node.left.name, node.left.start, shadows.get(rangeKey(writer)) ?? [])) {
        return;
      }
      const existing = writers.get(node.left.name) ?? [];
      if (!existing.some((item) => isDirectFunction(item, writer))) existing.push(writer);
      writers.set(node.left.name, existing);
    },
  }).visit(program);
  return writers;
}

function initializerEvidence(
  ownerPath: string,
  ownerSource: string,
  program: Program,
  nodes: FunctionNode[],
  projectFiles: ProjectFile[],
  reader: FunctionNode,
): InitializerEvidence[] {
  const result: InitializerEvidence[] = [];
  for (const node of nodes) {
    if (isDirectFunction(node, reader)) continue;
    const name = functionName(program, node);
    if (!name) continue;
    result.push({
      name,
      exported: isFunctionExported(program, node, name),
      source: ownerSource.slice(node.start, node.end),
      callers: findFunctionCallers(ownerPath, name, projectFiles),
    });
  }
  return result;
}

function callerModules(
  calls: FunctionCaller[],
  projectFiles: ProjectFile[],
): CallerModule[] {
  const paths = new Set(calls.map(({ filePath }) => filePath));
  return projectFiles
    .filter(({ filePath }) => paths.has(filePath))
    .map(({ filePath, source }) => ({ filePath, source: source.slice(0, 12_000) }))
    .slice(0, 20);
}

export function buildHiddenInitializationOrderEvidence(
  candidate: Candidate,
  projectFiles: ProjectFile[],
): HiddenInitializationOrderEvidence | undefined {
  if (candidate.kind !== "function") return undefined;
  const owner = projectFiles.find((file) => file.filePath === candidate.filePath);
  if (!owner) return undefined;
  const parsed = parseCached(owner.filePath, owner.source);
  if (parsed.errors.some((error) => error.severity === "Error")) return undefined;
  const fn = findDirectFunction(parsed.program, candidate);
  if (!fn) return undefined;
  const name = functionName(parsed.program, fn);
  if (!name) return undefined;

  const bindings = uninitializedMutableBindings(parsed.program, owner.source);
  if (bindings.length === 0) return undefined;
  const read = bindingsReadByFunction(parsed.program, fn, bindings);
  if (read.size === 0) return undefined;
  const writers = bindingWriters(parsed.program, new Set(bindings.map((binding) => binding.name)));
  const dependencies = bindings.flatMap((binding): InitializationDependency[] => {
    if (!read.has(binding.name)) return [];
    const initializers = initializerEvidence(
      owner.filePath,
      owner.source,
      parsed.program,
      writers.get(binding.name) ?? [],
      projectFiles,
      fn,
    );
    return initializers.length === 0 ? [] : [{ binding, initializers }];
  });
  if (dependencies.length === 0) return undefined;

  const callers = findFunctionCallers(candidate.filePath, name, projectFiles);
  const allCalls = [
    ...dependencies.flatMap(({ initializers }) => initializers.flatMap((item) => item.callers)),
    ...callers,
  ];
  return {
    function: {
      name,
      exported: isFunctionExported(parsed.program, fn, name),
      filePath: candidate.filePath,
      source: candidate.source,
      moduleSource: owner.source.slice(0, 16_000),
    },
    dependencies,
    callers,
    callerModules: callerModules(allCalls, projectFiles),
  };
}
