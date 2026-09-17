import { parseSync, Visitor } from "oxc-parser";
import type { AssignmentTarget, Expression } from "oxc-parser";
import type { Candidate, ProjectFile } from "../types.js";
import {
  findDirectFunction,
  findFunctionCallers,
  findFunctionCallersWithCoverage,
  findNamedFunction,
  functionName,
  isFunctionExported,
  moduleMutableBindings,
  resolveModule,
} from "./repository.js";
import type { FunctionCaller, FunctionNode } from "./repository.js";

export type FragmentedHelperCall = {
  call: string;
  line: number;
};

export type FragmentedHelper = {
  name: string;
  calls: FragmentedHelperCall[];
  exported: boolean;
  reexported: boolean;
  reexportPaths: string[];
  totalCalls: number;
  callsFromEntry: number;
  callsElsewhere: number;
  mutatesOuterState: boolean;
  writtenBindings: string[];
  readBindings: string[];
  writes: string[];
  statementCount: number;
  preview: string;
};

export type FragmentedWriteReadEdge = {
  binding: string;
  writer: string;
  reader: string;
  writerCallIndex: number;
  readerCallIndex: number;
};

export type FragmentedStatefulProcedureEvidence = {
  function: {
    name: string;
    exported: boolean;
    filePath: string;
    source: string;
  };
  orderedCalls: string[];
  helpers: FragmentedHelper[];
  writeReadEdges: FragmentedWriteReadEdge[];
  entryOwnStateOperations: string[];
  callers: FunctionCaller[];
};

type SourceRange = {
  start: number;
  end: number;
};

const KEYWORDS = new Set([
  "await", "break", "case", "catch", "const", "continue", "default", "delete", "do",
  "else", "export", "extends", "false", "finally", "for", "function", "if", "import",
  "in", "instanceof", "let", "new", "null", "of", "return", "static", "switch",
  "this", "throw", "true", "try", "typeof", "undefined", "var", "void", "while",
  "with", "yield", "as", "from", "get", "set", "async", "satisfies", "keyof",
  "interface", "type", "enum", "namespace", "declare", "abstract", "implements",
]);

const GLOBALS = new Set([
  "console", "process", "require", "module", "exports", "__dirname", "__filename",
  "JSON", "Object", "Array", "String", "Number", "Boolean", "Math", "Date",
  "RegExp", "Error", "Map", "Set", "Promise", "Symbol", "parseInt", "parseFloat",
  "isNaN",
]);

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

const OBJECT_MUTATORS = new Set([
  "assign",
  "defineProperties",
  "defineProperty",
  "setPrototypeOf",
]);

function lineAt(source: string, offset: number): number {
  let line = 1;
  for (let index = 0; index < offset; index += 1) {
    if (source[index] === "\n") line += 1;
  }
  return line;
}

function rootIdentifier(target: AssignmentTarget | Expression): string | undefined {
  if (target.type === "Identifier") return target.name;
  if (target.type === "MemberExpression") {
    return target.object.type === "Super" ? undefined : rootIdentifier(target.object);
  }
  if (target.type === "ChainExpression") return rootIdentifier(target.expression);
  if (target.type === "ParenthesizedExpression") return rootIdentifier(target.expression);
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

function bindingName(parameter: FunctionNode["params"][number]): string | undefined {
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

function inRange(node: SourceRange, scope: SourceRange): boolean {
  return node.start >= scope.start && node.end <= scope.end;
}

function nestedFunctionRanges(
  program: Parameters<Visitor["visit"]>[0],
  scope: SourceRange,
): SourceRange[] {
  const ranges: SourceRange[] = [];
  const addRange = (node: SourceRange): void => {
    if (
      inRange(node, scope)
      && (node.start !== scope.start || node.end !== scope.end)
    ) ranges.push({ start: node.start, end: node.end });
  };
  new Visitor({
    ArrowFunctionExpression: addRange,
    FunctionDeclaration: addRange,
    FunctionExpression: addRange,
  }).visit(program);
  return ranges;
}

function isDirectOperation(node: SourceRange, nested: SourceRange[]): boolean {
  return !nested.some((range) => range.start <= node.start && range.end >= node.end);
}

function readsIn(source: string): Set<string> {
  const scrubbed = source
    .replace(/\.\s*[A-Za-z_$][\w$]*/g, "")
    .replace(/(["'`])(?:\\.|(?!\1).)*\1/g, "")
    .replace(/\/\/[^\n]*/g, "");
  const reads = new Set<string>();
  for (const match of scrubbed.matchAll(/\b([A-Za-z_$][\w$]*)\b/g)) {
    const name = match[1];
    if (name && !KEYWORDS.has(name) && !GLOBALS.has(name)) reads.add(name);
  }
  return reads;
}

function reexportPaths(
  ownerPath: string,
  name: string,
  projectFiles: ProjectFile[],
): string[] {
  const paths: string[] = [];
  for (const file of projectFiles) {
    if (file.filePath === ownerPath) continue;
    const parsed = parseSync(file.filePath, file.source, { range: true });
    if (parsed.errors.some((error) => error.severity === "Error")) continue;
    for (const statement of parsed.program.body) {
      if (statement.type === "ExportAllDeclaration") {
        const resolved = resolveModule(file.filePath, statement.source.value, projectFiles);
        if (resolved?.filePath === ownerPath) paths.push(file.filePath);
      } else if (statement.type === "ExportNamedDeclaration" && statement.source) {
        const resolved = resolveModule(file.filePath, statement.source.value, projectFiles);
        if (resolved?.filePath !== ownerPath) continue;
        const names = statement.specifiers.map((specifier) => {
          if (specifier.local.type === "Identifier") return specifier.local.name;
          return specifier.exported.type === "Identifier" ? specifier.exported.name : "";
        });
        if (names.includes(name) || statement.specifiers.length === 0) paths.push(file.filePath);
      }
    }
  }
  return [...new Set(paths)].slice(0, 8);
}

type HelperCallSite = {
  name: string;
  call: string;
  line: number;
  index: number;
};

function collectEntryCalls(
  program: Parameters<Visitor["visit"]>[0],
  source: string,
  entry: FunctionNode,
  entryName: string,
): HelperCallSite[] {
  const scope = { start: entry.start, end: entry.end };
  const nested = nestedFunctionRanges(program, scope);
  const calls: HelperCallSite[] = [];
  new Visitor({
    CallExpression(node) {
      if (!inRange(node, scope) || !isDirectOperation(node, nested)) return;
      if (node.callee.type !== "Identifier") return;
      if (node.callee.name === entryName) return;
      const helper = findNamedFunction(program, node.callee.name);
      if (!helper || !helper.body) return;
      calls.push({
        name: node.callee.name,
        call: source.slice(node.start, node.end).slice(0, 120),
        line: lineAt(source, node.start),
        index: calls.length,
      });
    },
  }).visit(program);
  return calls;
}

type HelperScopeNames = {
  parameters: Set<string>;
  locals: Set<string>;
};

function collectLocalNames(
  program: Parameters<Visitor["visit"]>[0],
  helper: FunctionNode,
): HelperScopeNames {
  const scope = { start: helper.start, end: helper.end };
  const nested = nestedFunctionRanges(program, scope);
  const parameters = new Set<string>();
  for (const parameter of helper.params) {
    const name = bindingName(parameter);
    if (name) parameters.add(name);
  }
  const locals = new Set<string>(parameters);
  new Visitor({
    VariableDeclarator(node) {
      if (!inRange(node, scope) || !isDirectOperation(node, nested)) return;
      collectPatternIds(node.id, locals);
    },
    FunctionDeclaration(node) {
      if (!inRange(node, scope) || node.id == null) return;
      if (node.start !== helper.start) locals.add(node.id.name);
    },
  }).visit(program);
  return { parameters, locals };
}

function collectPatternIds(pattern: FunctionNode["params"][number] | import("oxc-parser").VariableDeclarator["id"], into: Set<string>): void {
  if (pattern.type === "Identifier") {
    into.add(pattern.name);
  } else if (pattern.type === "AssignmentPattern" && pattern.left.type === "Identifier") {
    into.add(pattern.left.name);
  } else if (pattern.type === "RestElement" && pattern.argument.type === "Identifier") {
    into.add(pattern.argument.name);
  } else if (pattern.type === "ObjectPattern") {
    for (const property of pattern.properties) {
      if (property.type === "Property" && property.value.type === "Identifier") {
        into.add(property.value.name);
      } else if (property.type === "RestElement" && property.argument.type === "Identifier") {
        into.add(property.argument.name);
      }
    }
  } else if (pattern.type === "ArrayPattern") {
    for (const element of pattern.elements) {
      if (element?.type === "Identifier") into.add(element.name);
    }
  }
}

function collectEntryOwnStateOperations(
  program: Parameters<Visitor["visit"]>[0],
  source: string,
  entry: FunctionNode,
): string[] {
  const scope = { start: entry.start, end: entry.end };
  const nested = nestedFunctionRanges(program, scope);
  const operations: string[] = [];
  const record = (node: SourceRange): void => {
    if (!inRange(node, scope) || !isDirectOperation(node, nested)) return;
    if (operations.length < 5) {
      operations.push(source.slice(node.start, node.end).slice(0, 120));
    }
  };
  new Visitor({
    AssignmentExpression: record,
    UpdateExpression: record,
    UnaryExpression(node) {
      if (node.operator === "delete") record(node);
    },
  }).visit(program);
  return operations;
}

type HelperMutationFacts = {
  mutatesOuterState: boolean;
  writtenBindings: string[];
  writes: string[];
};

function collectHelperMutations(
  program: Parameters<Visitor["visit"]>[0],
  source: string,
  helper: FunctionNode,
  moduleBindings: Set<string>,
): HelperMutationFacts {
  const scope = { start: helper.start, end: helper.end };
  const nested = nestedFunctionRanges(program, scope);
  const { parameters, locals } = collectLocalNames(program, helper);
  const written = new Set<string>();
  const writes: string[] = [];
  let mutatesOuterState = false;
  const recordWrite = (
    root: string | undefined,
    throughMember: boolean,
    node: SourceRange,
  ): void => {
    if (root === undefined) return;
    // Helper-owned bindings stay local, except that mutating through a
    // parameter member reaches caller-visible state outside the callee.
    if (locals.has(root) && !(parameters.has(root) && throughMember)) return;
    mutatesOuterState = true;
    if (moduleBindings.has(root) && !parameters.has(root)) {
      written.add(root);
    }
    if (writes.length < 8) writes.push(source.slice(node.start, node.end).slice(0, 120));
  };
  new Visitor({
    AssignmentExpression(node) {
      if (!inRange(node, scope) || !isDirectOperation(node, nested)) return;
      recordWrite(rootIdentifier(node.left), node.left.type === "MemberExpression", node);
    },
    UpdateExpression(node) {
      if (!inRange(node, scope) || !isDirectOperation(node, nested)) return;
      recordWrite(rootIdentifier(node.argument), node.argument.type === "MemberExpression", node);
    },
    UnaryExpression(node) {
      if (node.operator !== "delete") return;
      if (!inRange(node, scope) || !isDirectOperation(node, nested)) return;
      recordWrite(rootIdentifier(node.argument), node.argument.type === "MemberExpression", node);
    },
    CallExpression(node) {
      if (!inRange(node, scope) || !isDirectOperation(node, nested)) return;
      if (node.callee.type !== "MemberExpression") return;
      const method = memberName(node.callee);
      if (!method) return;
      if (MUTATING_METHODS.has(method)) {
        recordWrite(rootIdentifier(node.callee.object), true, node);
        return;
      }
      if (OBJECT_MUTATORS.has(method) && rootIdentifier(node.callee.object) === "Object") {
        const target = node.arguments[0];
        if (target && target.type !== "SpreadElement") recordWrite(rootIdentifier(target), true, node);
      }
    },
  }).visit(program);

  return {
    mutatesOuterState,
    writtenBindings: [...written],
    writes,
  };
}

function helperReadBindings(
  program: Parameters<Visitor["visit"]>[0],
  source: string,
  helper: FunctionNode,
  moduleBindings: Set<string>,
): string[] {
  const { locals } = collectLocalNames(program, helper);
  const reads = readsIn(source.slice(helper.start, helper.end));
  return [...reads].filter((name) => moduleBindings.has(name) && !locals.has(name));
}

function statementCount(helper: FunctionNode): number {
  if (!helper.body) return 0;
  if (helper.body.type === "BlockStatement") return helper.body.body.length;
  return 1;
}

export function buildFragmentedStatefulProcedureEvidence(
  candidate: Candidate,
  projectFiles: ProjectFile[],
): FragmentedStatefulProcedureEvidence | undefined {
  if (candidate.kind !== "function") return undefined;
  const owner = projectFiles.find((file) => file.filePath === candidate.filePath);
  if (!owner) return undefined;
  const parsed = parseSync(owner.filePath, owner.source, { range: true });
  if (parsed.errors.some((error) => error.severity === "Error")) return undefined;
  const entry = findDirectFunction(parsed.program, candidate);
  if (!entry) return undefined;
  const entryName = functionName(parsed.program, entry);
  if (!entryName) return undefined;
  if (!entry.body || entry.body.type !== "BlockStatement") return undefined;

  const callSites = collectEntryCalls(parsed.program, owner.source, entry, entryName);
  const helperNames = [...new Set(callSites.map((call) => call.name))];
  if (helperNames.length < 3) return undefined;

  const moduleBindings = new Set(moduleMutableBindings(parsed.program).map((binding) => binding.name));
  const entryStartLine = lineAt(owner.source, entry.start);
  const entryEndLine = lineAt(owner.source, entry.end);

  const helpers: FragmentedHelper[] = [];
  for (const name of helperNames) {
    const node = findNamedFunction(parsed.program, name);
    if (!node || !node.body) continue;
    const sites = callSites.filter((call) => call.name === name);
    const coverage = findFunctionCallersWithCoverage(owner.filePath, name, projectFiles);
    const callsFromEntry = coverage.callers.filter((caller) =>
      caller.filePath === owner.filePath
      && caller.line >= entryStartLine
      && caller.line <= entryEndLine
    ).length;
    const mutations = collectHelperMutations(parsed.program, owner.source, node, moduleBindings);
    const paths = reexportPaths(owner.filePath, name, projectFiles);
    helpers.push({
      name,
      calls: sites.map(({ call, line }) => ({ call, line })),
      exported: isFunctionExported(parsed.program, node, name),
      reexported: paths.length > 0,
      reexportPaths: paths,
      totalCalls: coverage.total,
      callsFromEntry,
      callsElsewhere: coverage.total - callsFromEntry,
      mutatesOuterState: mutations.mutatesOuterState,
      writtenBindings: mutations.writtenBindings,
      readBindings: helperReadBindings(parsed.program, owner.source, node, moduleBindings),
      writes: mutations.writes,
      statementCount: statementCount(node),
      preview: owner.source.slice(node.start, node.end).slice(0, 300),
    });
  }
  if (helpers.length < 3) return undefined;

  const firstIndex = new Map<string, number>();
  for (const site of callSites) {
    if (!firstIndex.has(site.name)) firstIndex.set(site.name, site.index);
  }
  const writeReadEdges: FragmentedWriteReadEdge[] = [];
  for (const writer of helpers) {
    for (const reader of helpers) {
      if (writer.name === reader.name) continue;
      const writerIndex = firstIndex.get(writer.name) ?? 0;
      const readerIndex = firstIndex.get(reader.name) ?? 0;
      if (writerIndex >= readerIndex) continue;
      for (const binding of writer.writtenBindings) {
        if (reader.readBindings.includes(binding)) {
          writeReadEdges.push({
            binding,
            writer: writer.name,
            reader: reader.name,
            writerCallIndex: writerIndex,
            readerCallIndex: readerIndex,
          });
        }
      }
      if (writeReadEdges.length >= 12) break;
    }
    if (writeReadEdges.length >= 12) break;
  }

  return {
    function: {
      name: entryName,
      exported: isFunctionExported(parsed.program, entry, entryName),
      filePath: owner.filePath,
      source: candidate.source,
    },
    orderedCalls: callSites.map((call) => call.name),
    helpers,
    writeReadEdges,
    entryOwnStateOperations: collectEntryOwnStateOperations(parsed.program, owner.source, entry),
    callers: findFunctionCallers(owner.filePath, entryName, projectFiles),
  };
}
