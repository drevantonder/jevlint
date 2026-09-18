import { Visitor } from "oxc-parser";
import { parseCached } from "./parse-cache.js";
import type { Node, Program } from "oxc-parser";
import type { Candidate, ProjectFile } from "../types.js";
import {
  belongsDirectlyToFunction,
  containsNode,
  nestedFunctionRanges,
} from "./function-scope.js";
import {
  findDirectFunction,
  findFunctionCallers,
  findModuleImporters,
  functionName,
  isFunctionExported,
  moduleImports,
  resolveModule,
} from "./repository.js";
import type { FunctionCaller, ModuleImporter } from "./repository.js";

export type ConceptOverlap = {
  sibling: string;
  sharedTokens: string[];
  siblingExports: string[];
  ownerExports: string[];
};

export type ParallelAbstractionEvidence = {
  function: {
    name: string | null;
    exported: boolean;
    filePath: string;
    source: string;
    moduleSource: string;
  };
  module: {
    filePath: string;
    exports: string[];
  };
  overlaps: ConceptOverlap[];
  delegation: {
    importedSymbols: string[];
    delegatesTo: string[];
  };
  repository: {
    callers: FunctionCaller[];
    importers: ModuleImporter[];
  };
};

const STOPWORDS = new Set([
  "service", "services", "manager", "helper", "helpers", "util", "utils",
  "index", "type", "types", "interface", "default", "impl", "base",
  "new", "create", "make", "get", "set", "use", "with", "and", "or",
  "the", "for", "handler", "controller",
]);

function nodeSource(node: Node, source: string): string {
  return source.slice(node.start, node.end);
}

function tokensOf(name: string): string[] {
  return name
    .replace(/[^A-Za-z0-9]+/g, " ")
    .replace(/([a-z0-9])([A-Z])/g, "$1 $2")
    .toLowerCase()
    .split(/\s+/)
    .filter((token) => token.length > 2 && !STOPWORDS.has(token));
}

function exportNames(program: Program): string[] {
  const names: string[] = [];
  const add = (name: string | undefined): void => {
    if (name && !names.includes(name)) names.push(name);
  };
  for (const statement of program.body) {
    if (statement.type === "ExportNamedDeclaration") {
      const declaration = statement.declaration;
      if (declaration?.type === "FunctionDeclaration" || declaration?.type === "ClassDeclaration") {
        add(declaration.id?.name);
      } else if (
        declaration?.type === "TSTypeAliasDeclaration"
        || declaration?.type === "TSInterfaceDeclaration"
        || declaration?.type === "TSEnumDeclaration"
      ) {
        add(declaration.id.name);
      } else if (declaration?.type === "VariableDeclaration") {
        for (const item of declaration.declarations) {
          if (item.id.type === "Identifier") add(item.id.name);
        }
      }
      for (const specifier of statement.specifiers) {
        if (specifier.exported.type === "Identifier") add(specifier.exported.name);
      }
    } else if (statement.type === "ExportDefaultDeclaration") {
      const declaration = statement.declaration;
      if (
        (declaration.type === "FunctionDeclaration" || declaration.type === "ClassDeclaration")
        && declaration.id?.name
      ) add(declaration.id.name);
    } else if (statement.type === "ExportAllDeclaration") {
      const source = statement.source.value;
      add(`* from ${source}`);
    }
  }
  return names;
}

function siblingSourceFiles(ownerPath: string, projectFiles: ProjectFile[]): ProjectFile[] {
  return projectFiles.filter((file) =>
    file.filePath !== ownerPath
    && /\.(?:[cm]?[jt]sx?)$/.test(file.filePath)
    && !/test|spec|__tests__|\.test\.|\.spec\.|\.d\.ts$/i.test(file.filePath)
  );
}

export function buildParallelAbstractionEvidence(
  candidate: Candidate,
  projectFiles: ProjectFile[],
): ParallelAbstractionEvidence | undefined {
  if (candidate.kind !== "function") return undefined;
  const ownerFile = projectFiles.find((file) => file.filePath === candidate.filePath);
  if (!ownerFile) return undefined;
  const parsed = parseCached(ownerFile.filePath, ownerFile.source);
  if (parsed.errors.some((error) => error.severity === "Error")) return undefined;
  const fn = findDirectFunction(parsed.program, candidate);
  if (!fn) return undefined;

  const ownerExports = exportNames(parsed.program);
  if (ownerExports.length === 0) return undefined;

  const ownerTokens = new Map<string, string[]>();
  for (const name of ownerExports) ownerTokens.set(name, tokensOf(name));

  const overlaps: ConceptOverlap[] = [];
  for (const sibling of siblingSourceFiles(candidate.filePath, projectFiles)) {
    let siblingProgram: Program;
    try {
      const siblingParsed = parseCached(sibling.filePath, sibling.source);
      if (siblingParsed.errors.some((error) => error.severity === "Error")) continue;
      siblingProgram = siblingParsed.program;
    } catch {
      continue;
    }
    const siblingExports = exportNames(siblingProgram);
    if (siblingExports.length === 0) continue;
    const shared = new Set<string>();
    for (const tokens of ownerTokens.values()) {
      for (const token of tokens) {
        if (siblingExports.some((siblingName) => tokensOf(siblingName).includes(token))) {
          shared.add(token);
        }
      }
    }
    if (shared.size > 0) {
      overlaps.push({
        sibling: sibling.filePath,
        sharedTokens: [...shared].sort(),
        siblingExports: siblingExports.slice(0, 12),
        ownerExports: ownerExports.slice(0, 12),
      });
    }
    if (overlaps.length >= 5) break;
  }

  const nested = nestedFunctionRanges(parsed.program, fn);
  const imported = moduleImports(parsed.program);
  const importedSymbols = [...new Set(imported.map(({ imported: symbol }) => symbol))];
  const delegatesTo = new Set<string>();
  new Visitor({
    CallExpression(call) {
      if (!containsNode(fn, call) || !belongsDirectlyToFunction(call, nested)) return;
      const text = nodeSource(call.callee, ownerFile.source);
      const root = text.split(/[.(]/)[0]?.trim() ?? "";
      const resolved = imported.find(({ local }) => local === root);
      if (resolved) {
        const target = resolveModule(candidate.filePath, resolved.source, projectFiles);
        delegatesTo.add(`${resolved.imported} from ${target?.filePath ?? resolved.source}`);
      }
    },
  }).visit(parsed.program);

  const name = functionName(parsed.program, fn);
  return {
    function: {
      name: name ?? null,
      exported: name ? isFunctionExported(parsed.program, fn, name) : false,
      filePath: candidate.filePath,
      source: candidate.source,
      moduleSource: ownerFile.source.slice(0, 16_000),
    },
    module: {
      filePath: candidate.filePath,
      exports: ownerExports.slice(0, 20),
    },
    overlaps,
    delegation: {
      importedSymbols: importedSymbols.slice(0, 20),
      delegatesTo: [...delegatesTo].slice(0, 10),
    },
    repository: {
      callers: name ? findFunctionCallers(candidate.filePath, name, projectFiles) : [],
      importers: findModuleImporters(candidate.filePath, projectFiles),
    },
  };
}
