import { posix } from "node:path";
import { parseSync, Visitor } from "oxc-parser";
import type {
  ArrowFunctionExpression,
  CallExpression,
  Function as OxcFunction,
  ImportDeclaration,
  Program,
} from "oxc-parser";
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

export function findFunctionCallers(
  ownerPath: string,
  functionName: string,
  projectFiles: ProjectFile[],
): FunctionCaller[] {
  const result: FunctionCaller[] = [];
  for (const file of projectFiles) {
    if (file.filePath === ownerPath) continue;
    const parsed = parseSync(file.filePath, file.source, { range: true });
    if (parsed.errors.some((error) => error.severity === "Error")) continue;
    const names = importedCallNames(
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
  return result.slice(0, 20);
}
