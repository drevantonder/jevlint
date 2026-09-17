import { Visitor } from "oxc-parser";
import type { Program } from "oxc-parser";
import type { Candidate, ProjectFile, SourceFile } from "../types.js";
import { findModuleImporters } from "./repository.js";
import {
  buildModuleEvidence,
  isFrameworkScaffolded,
  parseProgram,
} from "./module.js";
import type { ModuleEvidence } from "./module.js";

export type ConcreteExport = {
  name: string;
  kind: "function" | "class" | "value";
};

export type ConcreteStableModuleEvidence = {
  module: ModuleEvidence;
  importers: {
    count: number;
    files: string[];
    symbols: string[];
  };
  exports: {
    abstract: string[];
    concrete: ConcreteExport[];
  };
};

function topLevelKinds(program: Program): Map<string, ConcreteExport["kind"] | "abstract"> {
  const kinds = new Map<string, ConcreteExport["kind"] | "abstract">();
  const declare = (name: string | undefined, kind: ConcreteExport["kind"] | "abstract"): void => {
    if (name && !kinds.has(name)) kinds.set(name, kind);
  };
  new Visitor({
    FunctionDeclaration(node) {
      declare(node.id?.name, "function");
    },
    ClassDeclaration(node) {
      declare(node.id?.name, "class");
    },
    TSInterfaceDeclaration(node) {
      declare(node.id.name, "abstract");
    },
    TSTypeAliasDeclaration(node) {
      declare(node.id.name, "abstract");
    },
    VariableDeclarator(node) {
      if (node.id.type !== "Identifier") return;
      const init = node.init;
      if (!init) {
        declare(node.id.name, "value");
        return;
      }
      declare(
        node.id.name,
        init.type === "ArrowFunctionExpression" || init.type === "FunctionExpression"
          ? "function"
          : init.type === "ClassExpression" ? "class" : "value",
      );
    },
  }).visit(program);
  return kinds;
}

export function buildConcreteStableModuleEvidence(
  candidate: Candidate,
  projectFiles: ProjectFile[],
  changes: SourceFile[] = [],
): ConcreteStableModuleEvidence | undefined {
  if (candidate.kind !== "module") return undefined;
  if (isFrameworkScaffolded(candidate.filePath)) return undefined;
  const module = buildModuleEvidence(candidate.filePath, changes, projectFiles);
  if (!module) return undefined;
  const owner = projectFiles.find((file) => file.filePath === candidate.filePath);
  if (!owner) return undefined;
  const program = parseProgram(owner.filePath, owner.source);
  if (!program) return undefined;

  const kinds = topLevelKinds(program);
  const exportedNames = new Set<string>();
  for (const statement of program.body) {
    if (statement.type === "ExportDefaultDeclaration") {
      const declaration = statement.declaration;
      if (
        (declaration.type === "FunctionDeclaration" || declaration.type === "ClassDeclaration")
        && declaration.id?.name
      ) exportedNames.add(declaration.id.name);
      if (declaration.type === "Identifier") exportedNames.add(declaration.name);
      continue;
    }
    if (statement.type !== "ExportNamedDeclaration") continue;
    const declaration = statement.declaration;
    if (declaration?.type === "FunctionDeclaration" && declaration.id?.name) {
      exportedNames.add(declaration.id.name);
    } else if (declaration?.type === "ClassDeclaration" && declaration.id?.name) {
      exportedNames.add(declaration.id.name);
    } else if (
      declaration?.type === "TSInterfaceDeclaration" || declaration?.type === "TSTypeAliasDeclaration"
    ) {
      exportedNames.add(declaration.id.name);
    } else if (declaration?.type === "VariableDeclaration") {
      for (const item of declaration.declarations) {
        if (item.id.type === "Identifier") exportedNames.add(item.id.name);
      }
    }
    for (const specifier of statement.specifiers) {
      if (specifier.local.type === "Identifier") exportedNames.add(specifier.local.name);
    }
  }

  const abstract: string[] = [];
  const concrete: ConcreteExport[] = [];
  for (const name of exportedNames) {
    const kind = kinds.get(name);
    if (kind === "abstract") abstract.push(name);
    else if (kind !== undefined) concrete.push({ name, kind });
  }
  abstract.sort();
  concrete.sort((left, right) => left.name.localeCompare(right.name));
  if (abstract.length > 0 || concrete.length === 0) return undefined;

  const importers = findModuleImporters(candidate.filePath, projectFiles);
  if (importers.length === 0) return undefined;
  const symbols = [...new Set(importers.flatMap((item) => item.importedSymbols))].sort();

  return {
    module,
    importers: {
      count: importers.length,
      files: importers.map((item) => item.filePath).sort().slice(0, 8),
      symbols: symbols.slice(0, 12),
    },
    exports: { abstract, concrete },
  };
}
