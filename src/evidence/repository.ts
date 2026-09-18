import { posix } from "node:path";
import { Visitor } from "oxc-parser";
import { parseCached } from "./parse-cache.js";
import type {
  ArrowFunctionExpression,
  CallExpression,
  Expression,
  Function as OxcFunction,
  ImportDeclaration,
  Node,
  Program,
  TSInterfaceDeclaration,
  TSTypeAliasDeclaration,
} from "oxc-parser";
import { z } from "zod";
import type { Candidate, ProjectFile } from "../types.js";

export type FunctionNode = OxcFunction | ArrowFunctionExpression;

export type ModuleImport = {
  source: string;
  local: string;
  imported: string;
};

export type FunctionCaller = {
  filePath: string;
  call: string;
  arguments: string[];
  line: number;
};

export type FunctionCallersCoverage = {
  callers: FunctionCaller[];
  total: number;
};

export type RelatedProjectModule = {
  filePath: string;
  importedFrom: string;
  importedSymbols: string[];
  source: string;
};

type SourceRange = {
  start: number;
  end: number;
};

interface ImportedCallNames {
  identifiers: Set<string>;
  namespaces: Set<string>;
}

function importedName(specifier: ImportDeclaration["specifiers"][number]): string {
  if (specifier.type === "ImportSpecifier") {
    return specifier.imported.type === "Identifier"
      ? specifier.imported.name
      : specifier.imported.value;
  }
  return specifier.type === "ImportDefaultSpecifier" ? "default" : "*";
}

export function moduleImports(program: Program): ModuleImport[] {
  const result: ModuleImport[] = [];
  for (const statement of program.body) {
    if (statement.type !== "ImportDeclaration") continue;
    for (const specifier of statement.specifiers) {
      result.push({
        source: statement.source.value,
        local: specifier.local.name,
        imported: importedName(specifier),
      });
    }
  }
  return result;
}

export function findDirectFunction(
  program: Program,
  candidate: Candidate,
): FunctionNode | undefined {
  let result: FunctionNode | undefined;
  const matches = (node: FunctionNode): void => {
    if (node.start === candidate.start && node.end === candidate.end) result = node;
  };
  new Visitor({
    ArrowFunctionExpression: matches,
    FunctionDeclaration: matches,
    FunctionExpression: matches,
  }).visit(program);
  return result;
}

export function nestedFunctionRanges(
  program: Program,
  candidate: Candidate,
): SourceRange[] {
  const ranges: SourceRange[] = [];
  const addRange = (node: FunctionNode): void => {
    if (
      node.start >= candidate.start
      && node.end <= candidate.end
      && (node.start !== candidate.start || node.end !== candidate.end)
    ) ranges.push({ start: node.start, end: node.end });
  };
  new Visitor({
    ArrowFunctionExpression: addRange,
    FunctionDeclaration: addRange,
    FunctionExpression: addRange,
  }).visit(program);
  return ranges;
}

export function isInsideNestedFunction(node: Node, ranges: SourceRange[]): boolean {
  return ranges.some((range) => range.start <= node.start && range.end >= node.end);
}

export function functionName(program: Program, node: FunctionNode): string | undefined {
  if (node.id?.name) return node.id.name;
  let name: string | undefined;
  new Visitor({
    VariableDeclarator(declaration) {
      if (declaration.init === node && declaration.id.type === "Identifier") {
        name = declaration.id.name;
      }
    },
  }).visit(program);
  return name;
}

export function isFunctionExported(
  program: Program,
  node: FunctionNode,
  name: string,
): boolean {
  for (const statement of program.body) {
    if (statement.type === "ExportDefaultDeclaration" && statement.declaration === node) return true;
    if (statement.type !== "ExportNamedDeclaration") continue;
    if (statement.declaration === node) return true;
    if (
      statement.declaration?.type === "VariableDeclaration"
      && statement.declaration.declarations.some((declaration) => declaration.init === node)
    ) return true;
    if (statement.specifiers.some((specifier) => {
      const local = specifier.local;
      return local.type === "Identifier" && local.name === name;
    })) return true;
  }
  return false;
}

function possibleModulePaths(fromFile: string, specifier: string): string[] {
  if (!specifier.startsWith(".")) return [];
  const joined = posix.normalize(posix.join(posix.dirname(fromFile), specifier));
  const withoutKnownExtension = joined.replace(/\.(?:[cm]?[jt]sx?)$/, "");
  return [
    joined,
    `${withoutKnownExtension}.ts`,
    `${withoutKnownExtension}.tsx`,
    `${withoutKnownExtension}.mts`,
    `${withoutKnownExtension}.cts`,
    `${withoutKnownExtension}.js`,
    `${withoutKnownExtension}.jsx`,
    `${withoutKnownExtension}/index.ts`,
    `${withoutKnownExtension}/index.tsx`,
    `${withoutKnownExtension}/index.js`,
  ];
}

export function resolveModule(
  fromFile: string,
  specifier: string,
  projectFiles: ProjectFile[],
): ProjectFile | undefined {
  const paths = new Set(possibleModulePaths(fromFile, specifier));
  return projectFiles.find((file) => paths.has(posix.normalize(file.filePath)));
}

export function findRelatedProjectModules(
  ownerPath: string,
  program: Program,
  projectFiles: ProjectFile[],
): RelatedProjectModule[] {
  const modules = new Map<string, RelatedProjectModule>();
  for (const imported of moduleImports(program)) {
    const resolved = resolveModule(ownerPath, imported.source, projectFiles);
    if (!resolved || resolved.filePath === ownerPath) continue;
    const existing = modules.get(resolved.filePath);
    if (existing) {
      if (!existing.importedSymbols.includes(imported.imported)) {
        existing.importedSymbols.push(imported.imported);
      }
      continue;
    }
    modules.set(resolved.filePath, {
      filePath: resolved.filePath,
      importedFrom: imported.source,
      importedSymbols: [imported.imported],
      source: resolved.source.slice(0, 12_000),
    });
  }
  return [...modules.values()].slice(0, 12);
}

function lineAt(source: string, offset: number): number {
  let line = 1;
  for (let index = 0; index < offset; index += 1) {
    if (source[index] === "\n") line += 1;
  }
  return line;
}

function importedCallNames(
  program: Program,
  callerPath: string,
  ownerPath: string,
  functionName: string,
  projectFiles: ProjectFile[],
): ImportedCallNames {
  const identifiers = new Set<string>();
  const namespaces = new Set<string>();
  for (const imported of moduleImports(program)) {
    const resolved = resolveModule(callerPath, imported.source, projectFiles);
    if (resolved?.filePath !== ownerPath) continue;
    if (imported.imported === functionName || imported.imported === "default") {
      identifiers.add(imported.local);
    } else if (imported.imported === "*") {
      namespaces.add(imported.local);
    }
  }
  return { identifiers, namespaces };
}

function isMatchingCall(
  call: CallExpression,
  functionName: string,
  identifiers: Set<string>,
  namespaces: Set<string>,
): boolean {
  if (call.callee.type === "Identifier") return identifiers.has(call.callee.name);
  if (
    call.callee.type === "MemberExpression"
    && call.callee.object.type === "Identifier"
    && namespaces.has(call.callee.object.name)
    && call.callee.property.type === "Identifier"
  ) return call.callee.property.name === functionName;
  return false;
}

function collectFunctionCallers(
  ownerPath: string,
  functionName: string,
  projectFiles: ProjectFile[],
): FunctionCaller[] {
  const result: FunctionCaller[] = [];
  for (const file of projectFiles) {
    const parsed = parseCached(file.filePath, file.source);
    if (parsed.errors.some((error) => error.severity === "Error")) continue;
    const names = file.filePath === ownerPath
      ? { identifiers: new Set([functionName]), namespaces: new Set<string>() }
      : importedCallNames(
        parsed.program,
        file.filePath,
        ownerPath,
        functionName,
        projectFiles,
      );
    if (names.identifiers.size === 0 && names.namespaces.size === 0) continue;
    new Visitor({
      CallExpression(call) {
        if (!isMatchingCall(call, functionName, names.identifiers, names.namespaces)) return;
        result.push({
          filePath: file.filePath,
          call: file.source.slice(call.start, call.end),
          arguments: call.arguments.map((argument) => file.source.slice(argument.start, argument.end)),
          line: lineAt(file.source, call.start),
        });
      },
    }).visit(parsed.program);
  }
  return result;
}

export function findFunctionCallers(
  ownerPath: string,
  functionName: string,
  projectFiles: ProjectFile[],
): FunctionCaller[] {
  return collectFunctionCallers(ownerPath, functionName, projectFiles).slice(0, 20);
}

export function findFunctionCallersWithCoverage(
  ownerPath: string,
  functionName: string,
  projectFiles: ProjectFile[],
): FunctionCallersCoverage {
  const callers = collectFunctionCallers(ownerPath, functionName, projectFiles);
  return { callers, total: callers.length };
}

export type AbstractionNode = TSInterfaceDeclaration | TSTypeAliasDeclaration;

export function findDirectAbstraction(
  program: Program,
  candidate: Candidate,
): AbstractionNode | undefined {
  let result: AbstractionNode | undefined;
  const matches = (node: AbstractionNode): void => {
    if (node.start === candidate.start && node.end === candidate.end) result = node;
  };
  new Visitor({
    TSInterfaceDeclaration: matches,
    TSTypeAliasDeclaration: matches,
  }).visit(program);
  return result;
}

export function abstractionName(_program: Program, node: AbstractionNode): string {
  return node.id.name;
}

export function isAbstractionExported(
  program: Program,
  node: AbstractionNode,
  name: string,
): boolean {
  for (const statement of program.body) {
    if (statement.type !== "ExportNamedDeclaration") continue;
    if (statement.declaration === node) return true;
    if (statement.specifiers.some((specifier) => {
      const local = specifier.local;
      return local.type === "Identifier" && local.name === name;
    })) return true;
  }
  return false;
}

export type ModuleImporter = {
  filePath: string;
  importedSymbols: string[];
  source: string;
};

export function findModuleImporters(
  ownerPath: string,
  projectFiles: ProjectFile[],
): ModuleImporter[] {
  const result: ModuleImporter[] = [];
  for (const file of projectFiles) {
    if (file.filePath === ownerPath) continue;
    const parsed = parseCached(file.filePath, file.source);
    if (parsed.errors.some((error) => error.severity === "Error")) continue;
    const symbols: string[] = [];
    for (const imported of moduleImports(parsed.program)) {
      const resolved = resolveModule(file.filePath, imported.source, projectFiles);
      if (resolved?.filePath !== ownerPath) continue;
      if (!symbols.includes(imported.imported)) symbols.push(imported.imported);
    }
    if (symbols.length > 0) {
      result.push({
        filePath: file.filePath,
        importedSymbols: symbols,
        source: file.source.slice(0, 12_000),
      });
    }
  }
  return result.slice(0, 12);
}

export type ModuleMutableBinding = {
  name: string;
  kind: "let" | "var" | "const";
  start: number;
  end: number;
};

export function moduleMutableBindings(program: Program): ModuleMutableBinding[] {
  const bindings: ModuleMutableBinding[] = [];
  for (const statement of program.body) {
    const declaration = statement.type === "ExportNamedDeclaration"
      ? statement.declaration
      : statement;
    if (declaration?.type !== "VariableDeclaration") continue;
    if (declaration.kind !== "let" && declaration.kind !== "var" && declaration.kind !== "const") {
      continue;
    }
    for (const item of declaration.declarations) {
      if (item.id.type !== "Identifier") continue;
      if (declaration.kind === "const") {
        const init = item.init;
        if (
          init?.type !== "ObjectExpression"
          && init?.type !== "ArrayExpression"
          && init?.type !== "NewExpression"
        ) continue;
      }
      bindings.push({
        name: item.id.name,
        kind: declaration.kind,
        start: declaration.start,
        end: declaration.end,
      });
    }
  }
  return bindings;
}

export function calleeRootName(callee: CallExpression["callee"]): string | null {
  if (callee.type === "Identifier") return callee.name;
  if (callee.type === "MemberExpression") {
    if (callee.object.type === "Super") return null;
    return memberObjectRoot(callee.object);
  }
  if (callee.type === "ChainExpression") {
    const chained = callee.expression;
    if (chained.type === "CallExpression") return calleeRootName(chained.callee);
    if (chained.type === "MemberExpression") {
      if (chained.object.type === "Super") return null;
      return memberObjectRoot(chained.object);
    }
  }
  return null;
}

function memberObjectRoot(object: Expression): string | null {
  if (object.type === "Identifier") return object.name;
  if (object.type === "MemberExpression") {
    if (object.object.type === "Super") return null;
    return memberObjectRoot(object.object);
  }
  if (object.type === "CallExpression") return calleeRootName(object.callee);
  return null;
}

export function findNamedFunction(
  program: Program,
  name: string,
): FunctionNode | undefined {
  let result: FunctionNode | undefined;
  new Visitor({
    FunctionDeclaration(node) {
      if (result === undefined && node.id?.name === name) result = node;
    },
    VariableDeclarator(node) {
      if (result !== undefined || node.id.type !== "Identifier" || node.id.name !== name) return;
      if (
        node.init?.type === "ArrowFunctionExpression"
        || node.init?.type === "FunctionExpression"
      ) result = node.init;
    },
  }).visit(program);
  return result;
}

const manifestDependencySection = z.record(z.string(), z.string());

const manifestSchema = z.object({
  dependencies: manifestDependencySection.optional(),
  devDependencies: manifestDependencySection.optional(),
  peerDependencies: manifestDependencySection.optional(),
  optionalDependencies: manifestDependencySection.optional(),
});

export type ManifestDependency = {
  name: string;
  section: string;
  version: string;
};

export function manifestDependencies(source: string): ManifestDependency[] {
  let json: unknown;
  try {
    json = JSON.parse(source);
  } catch {
    return [];
  }
  const parsed = manifestSchema.safeParse(json);
  if (!parsed.success) return [];
  const result: ManifestDependency[] = [];
  const sections = [
    { section: "dependencies", entries: parsed.data.dependencies },
    { section: "devDependencies", entries: parsed.data.devDependencies },
    { section: "peerDependencies", entries: parsed.data.peerDependencies },
    { section: "optionalDependencies", entries: parsed.data.optionalDependencies },
  ];
  for (const { section, entries } of sections) {
    if (!entries) continue;
    for (const [name, version] of Object.entries(entries)) {
      result.push({ name, section, version });
    }
  }
  return result;
}
