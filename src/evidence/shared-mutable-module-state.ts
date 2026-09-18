import { Visitor } from "oxc-parser";
import { parseCached } from "./parse-cache.js";
import type { AssignmentExpression, Expression, Program } from "oxc-parser";
import type { Candidate, ProjectFile } from "../types.js";
import {
  belongsDirectlyToFunction,
  containsNode,
  nestedFunctionRanges,
} from "./function-scope.js";
import {
  abstractionName,
  findDirectAbstraction,
  findFunctionCallers,
  findModuleImporters,
  isAbstractionExported,
  moduleMutableBindings,
} from "./repository.js";
import type {
  FunctionCaller,
  FunctionNode,
  ModuleImporter,
} from "./repository.js";
type ModuleFunction = {
  name: string;
  node: FunctionNode;
  exported: boolean;
};

type SharedBindingEvidence = {
  binding: string;
  declaration: string;
  kind: "let" | "var" | "const";
  writers: { function: string; excerpts: string[] }[];
  readers: string[];
  resetOrInspectExport: string | null;
};

export type SharedMutableModuleStateEvidence = {
  abstraction: {
    name: string;
    exported: boolean;
    filePath: string;
    source: string;
    moduleSource: string;
  };
  sharedBindings: SharedBindingEvidence[];
  repository: {
    importers: ModuleImporter[];
    callers: FunctionCaller[];
  };
};

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

function moduleFunctions(program: Program): ModuleFunction[] {
  const functions: ModuleFunction[] = [];
  const add = (
    name: string | undefined,
    node: FunctionNode,
    exported: boolean,
  ): void => {
    if (name) functions.push({ name, node, exported });
  };
  for (const statement of program.body) {
    const exported = statement.type === "ExportNamedDeclaration";
    const declaration = exported ? statement.declaration : statement;
    if (declaration?.type === "FunctionDeclaration") {
      add(declaration.id?.name, declaration, exported || statement.type === "ExportDefaultDeclaration");
      continue;
    }
    if (statement.type === "ExportDefaultDeclaration") {
      const value = statement.declaration;
      if (
        value.type === "ArrowFunctionExpression"
        || value.type === "FunctionExpression"
        || value.type === "FunctionDeclaration"
      ) {
        add(value.type === "FunctionDeclaration" ? value.id?.name : undefined, value, true);
      }
      continue;
    }
    if (declaration?.type !== "VariableDeclaration") continue;
    for (const item of declaration.declarations) {
      if (item.id.type !== "Identifier" || !item.init) continue;
      if (
        item.init.type === "ArrowFunctionExpression"
        || item.init.type === "FunctionExpression"
      ) add(item.id.name, item.init, exported);
    }
  }
  return functions;
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

function writeExcerpts(
  fn: FunctionNode,
  binding: string,
  program: Program,
  source: string,
): string[] {
  const nested = nestedFunctionRanges(program, fn);
  const excerpts: string[] = [];
  new Visitor({
    AssignmentExpression(node) {
      if (!containsNode(fn, node) || !belongsDirectlyToFunction(node, nested)) return;
      if (assignmentRoot(node.left) === binding) excerpts.push(source.slice(node.start, node.end));
    },
    UpdateExpression(node) {
      if (!containsNode(fn, node) || !belongsDirectlyToFunction(node, nested)) return;
      if (node.argument.type === "Identifier" && node.argument.name === binding) {
        excerpts.push(source.slice(node.start, node.end));
      }
    },
    CallExpression(call) {
      if (!containsNode(fn, call) || !belongsDirectlyToFunction(call, nested)) return;
      const callee = call.callee;
      if (
        callee.type === "MemberExpression"
        && callee.object.type === "Identifier"
        && callee.object.name === binding
        && callee.property.type === "Identifier"
        && MUTATING_METHODS.has(callee.property.name)
      ) excerpts.push(source.slice(call.start, call.end));
    },
  }).visit(program);
  return excerpts;
}

function readsBinding(
  fn: FunctionNode,
  binding: string,
  program: Program,
): boolean {
  if (parameterNames(fn).includes(binding)) return false;
  const nested = nestedFunctionRanges(program, fn);
  let found = false;
  new Visitor({
    Identifier(node) {
      if (found || !containsNode(fn, node) || !belongsDirectlyToFunction(node, nested)) return;
      if (node.name === binding) found = true;
    },
  }).visit(program);
  return found;
}

function resetOrInspect(
  fn: ModuleFunction,
  binding: string,
  program: Program,
  source: string,
): string | null {
  if (!fn.exported) return null;
  const nested = nestedFunctionRanges(program, fn.node);
  let result: string | null = null;
  new Visitor({
    ReturnStatement(node) {
      if (result || !node.argument || !containsNode(fn.node, node)) return;
      if (!belongsDirectlyToFunction(node, nested)) return;
      const text = source.slice(node.argument.start, node.argument.end);
      if (text === binding || text.startsWith(`${binding}.`) || text.startsWith(`${binding}[`)) {
        result = `inspects shared state: ${source.slice(node.start, node.end)}`;
      }
    },
    AssignmentExpression(node) {
      if (result || !containsNode(fn.node, node)) return;
      if (!belongsDirectlyToFunction(node, nested)) return;
      if (assignmentRoot(node.left) !== binding) return;
      const text = source.slice(node.right.start, node.right.end);
      if (/^(\[\]|\{\}|null|undefined|0|""|'')$/.test(text.trim())) {
        result = `resets shared state: ${source.slice(node.start, node.end)}`;
      }
    },
  }).visit(program);
  return result;
}

export function buildSharedMutableModuleStateEvidence(
  candidate: Candidate,
  projectFiles: ProjectFile[],
): SharedMutableModuleStateEvidence | undefined {
  if (candidate.kind !== "abstraction") return undefined;
  const ownerFile = projectFiles.find((file) => file.filePath === candidate.filePath);
  if (!ownerFile) return undefined;
  const parsed = parseCached(ownerFile.filePath, ownerFile.source);
  if (parsed.errors.some((error) => error.severity === "Error")) return undefined;
  const abstraction = findDirectAbstraction(parsed.program, candidate);
  if (!abstraction) return undefined;

  const source = ownerFile.source;
  const functions = moduleFunctions(parsed.program);
  const shared: SharedBindingEvidence[] = [];
  const involved = new Set<string>();

  for (const binding of moduleMutableBindings(parsed.program)) {
    const writers = functions.flatMap((fn) => {
      const excerpts = writeExcerpts(fn.node, binding.name, parsed.program, source);
      return excerpts.length > 0 ? [{ function: fn.name, excerpts: excerpts.slice(0, 5) }] : [];
    });
    if (new Set(writers.map(({ function: name }) => name)).size < 2) continue;
    const writerNames = new Set(writers.map(({ function: name }) => name));
    const readers = functions
      .filter(({ name }) => !writerNames.has(name))
      .filter(({ node }) => readsBinding(node, binding.name, parsed.program))
      .map(({ name }) => name);
    const seam = functions
      .map((fn) => resetOrInspect(fn, binding.name, parsed.program, source))
      .find((value): value is string => value !== null) ?? null;
    for (const name of [...writerNames, ...readers]) involved.add(name);
    shared.push({
      binding: binding.name,
      declaration: source.slice(binding.start, binding.end),
      kind: binding.kind,
      writers,
      readers,
      resetOrInspectExport: seam,
    });
  }

  if (shared.length === 0) return undefined;

  const name = abstractionName(parsed.program, abstraction);
  const callers = [...involved].flatMap((fn) =>
    findFunctionCallers(candidate.filePath, fn, projectFiles)
  ).slice(0, 20);
  return {
    abstraction: {
      name,
      exported: isAbstractionExported(parsed.program, abstraction, name),
      filePath: candidate.filePath,
      source: candidate.source,
      moduleSource: ownerFile.source.slice(0, 16_000),
    },
    sharedBindings: shared,
    repository: {
      importers: findModuleImporters(candidate.filePath, projectFiles),
      callers,
    },
  };
}
