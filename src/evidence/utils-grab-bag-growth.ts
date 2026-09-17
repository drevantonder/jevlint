import { posix } from "node:path";
import type { Candidate, ProjectFile, SourceFile } from "../types.js";
import { buildModuleEvidence, isFrameworkScaffolded, parseProgram } from "./module.js";
import type { ModuleEvidence } from "./module.js";
import { findModuleImporters } from "./repository.js";

const MISC_BASENAMES = new Set(["utils", "util", "helpers", "helper", "common", "misc"]);

const MAX_IMPORTER_TOPICS = 10;

export type UtilsGrabBagGrowthEvidence = {
  module: ModuleEvidence;
  host: {
    filePath: string;
  };
  beforeExports: string[];
  afterExports: string[];
  addedExports: string[];
  existingDomains: string[];
  importerTopics: string[];
};

function exportedSymbolName(specifier: { exported: { type: string; name?: string; value?: string } }): string {
  const exported = specifier.exported;
  if (exported.type === "Identifier" && exported.name) return exported.name;
  if (exported.value) return exported.value;
  return "unknown";
}

function hostStem(filePath: string): string | null {
  const basename = posix.basename(filePath);
  if (/^index\.[cm]?[jt]sx?$/.test(basename)) {
    const segments = posix.normalize(filePath).split("/");
    const parent = segments[segments.length - 2];
    return parent ? parent.toLowerCase() : null;
  }
  const dot = basename.indexOf(".");
  const stem = (dot > 0 ? basename.slice(0, dot) : basename).toLowerCase();
  return stem;
}

function domainStem(name: string): string {
  const parts = name
    .replace(/([a-z0-9])([A-Z])/g, "$1 $2")
    .split(/[^A-Za-z0-9]+/)
    .filter(Boolean)
    .map((part) => part.toLowerCase());
  const first = parts[0];
  if (!first) return name.toLowerCase();
  if ((first === "get" || first === "set" || first === "is" || first === "has") && parts[1]) {
    return parts[1]!;
  }
  return first;
}

function exportNamesOf(filePath: string, source: string): string[] | undefined {
  const program = parseProgram(filePath, source);
  if (!program) return undefined;
  const names = new Set<string>();
  for (const statement of program.body) {
    if (statement.type === "ExportAllDeclaration") {
      names.add("*");
      continue;
    }
    if (statement.type === "ExportDefaultDeclaration") {
      names.add("default");
      continue;
    }
    if (statement.type !== "ExportNamedDeclaration") continue;
    if (statement.declaration) {
      const declaration = statement.declaration;
      if (
        (declaration.type === "FunctionDeclaration"
          || declaration.type === "ClassDeclaration"
          || declaration.type === "TSInterfaceDeclaration"
          || declaration.type === "TSTypeAliasDeclaration")
        && declaration.id
      ) {
        names.add(declaration.id.name);
      } else if (declaration.type === "VariableDeclaration") {
        for (const declarator of declaration.declarations) {
          if (declarator.id.type === "Identifier") names.add(declarator.id.name);
        }
      }
      continue;
    }
    for (const specifier of statement.specifiers) {
      names.add(exportedSymbolName(specifier));
    }
  }
  return [...names].sort();
}

export function buildUtilsGrabBagGrowthEvidence(
  candidate: Candidate,
  projectFiles: ProjectFile[],
  changes: SourceFile[] = [],
): UtilsGrabBagGrowthEvidence | undefined {
  if (candidate.kind !== "module") return undefined;
  if (!MISC_BASENAMES.has(hostStem(candidate.filePath) ?? "")) return undefined;
  if (isFrameworkScaffolded(candidate.filePath)) return undefined;
  const module = buildModuleEvidence(candidate.filePath, changes, projectFiles);
  if (!module) return undefined;

  const change = changes.find((item) => item.filePath === candidate.filePath);
  const owner = projectFiles.find((file) => file.filePath === candidate.filePath);
  if (!owner) return undefined;
  const beforeSource = change?.oldSource ?? null;
  if (beforeSource === null) return undefined;
  const beforeExports = exportNamesOf(candidate.filePath, beforeSource);
  const afterExports = exportNamesOf(candidate.filePath, owner.source);
  if (!beforeExports || !afterExports) return undefined;

  const before = new Set(beforeExports.filter((name) => name !== "*" && name !== "default"));
  const addedExports = afterExports.filter((name) =>
    name !== "*" && name !== "default" && !before.has(name)
  );
  if (addedExports.length === 0) return undefined;

  const existingDomains = [...new Set([...before].map(domainStem))].sort();
  if (existingDomains.length < 3) return undefined;

  const novel = addedExports.filter((name) => !existingDomains.includes(domainStem(name)));
  if (novel.length === 0) return undefined;

  const topics = new Set<string>();
  for (const importer of findModuleImporters(candidate.filePath, projectFiles)) {
    const segments = importer.filePath.split("/");
    topics.add(segments.length > 1 ? segments[0]! : "(root)");
    if (topics.size >= MAX_IMPORTER_TOPICS) break;
  }

  return {
    module,
    host: { filePath: candidate.filePath },
    beforeExports,
    afterExports,
    addedExports,
    existingDomains,
    importerTopics: [...topics].sort(),
  };
}