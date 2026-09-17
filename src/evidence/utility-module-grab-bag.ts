import { parseSync } from "oxc-parser";
import type { ModuleExportName } from "oxc-parser";
import type { Candidate, ProjectFile, SourceFile } from "../types.js";
import { findModuleImporters } from "./repository.js";

export type UtilityExportFootprint = {
  name: string;
  isNew: boolean;
  importerFiles: string[];
};

export type UtilityModuleGrabBagEvidence = {
  moduleFile: string;
  newExports: string[];
  existingExports: string[];
  footprints: UtilityExportFootprint[];
  disjointImporterPairs: number;
};

const GRAB_BAG_PATTERN = /(^|\/)(utils?|common|shared|helpers?|commons)([/.]|$)/i;
const MAX_EXPORTS = 12;

function exportedSpecifierName(exported: ModuleExportName): string {
  return exported.type === "Literal" ? exported.value : exported.name;
}

function exportNames(filePath: string, source: string): string[] | undefined {
  const parsed = parseSync(filePath, source, { range: true });
  if (parsed.errors.some((error) => error.severity === "Error")) return undefined;
  const names: string[] = [];
  const push = (name: string): void => {
    if (!names.includes(name)) names.push(name);
  };
  for (const statement of parsed.program.body) {
    if (statement.type === "ExportAllDeclaration" || statement.type === "ExportDefaultDeclaration") {
      push(statement.type === "ExportDefaultDeclaration" ? "default" : "*");
      continue;
    }
    if (statement.type !== "ExportNamedDeclaration") continue;
    const { declaration } = statement;
    if (declaration?.type === "FunctionDeclaration" || declaration?.type === "ClassDeclaration") {
      if (declaration.id?.name) push(declaration.id.name);
    } else if (declaration?.type === "VariableDeclaration") {
      for (const item of declaration.declarations) {
        if (item.id.type === "Identifier") push(item.id.name);
      }
    } else if (
      declaration?.type === "TSInterfaceDeclaration" || declaration?.type === "TSTypeAliasDeclaration"
      || declaration?.type === "TSEnumDeclaration"
    ) {
      push(declaration.id.name);
    }
    for (const specifier of statement.specifiers) {
      push(exportedSpecifierName(specifier.exported));
    }
    if (names.length >= MAX_EXPORTS) break;
  }
  return names;
}

export function buildUtilityModuleGrabBagEvidence(
  candidate: Candidate,
  changes: SourceFile[],
  projectFiles: ProjectFile[] = changes.map(({ filePath, source }) => ({ filePath, source })),
): UtilityModuleGrabBagEvidence | undefined {
  if (candidate.kind !== "change") return undefined;
  if (!GRAB_BAG_PATTERN.test(candidate.filePath)) return undefined;
  const change = changes.find(({ filePath }) => filePath === candidate.filePath);
  if (!change || change.oldSource === null) return undefined;
  const after = exportNames(change.filePath, change.source);
  const before = exportNames(change.filePath, change.oldSource);
  if (!after || !before) return undefined;
  const newExports = after.filter((name) => !before.includes(name) && name !== "*" && name !== "default");
  if (newExports.length === 0 || before.length === 0) return undefined;

  const importers = findModuleImporters(change.filePath, projectFiles);
  const footprints: UtilityExportFootprint[] = [...before, ...newExports].slice(0, MAX_EXPORTS).map((name) => ({
    name,
    isNew: newExports.includes(name),
    importerFiles: importers
      .filter(({ importedSymbols }) => importedSymbols.includes(name) || importedSymbols.includes("*"))
      .map(({ filePath }) => filePath)
      .slice(0, 8),
  }));

  let disjointImporterPairs = 0;
  for (let left = 0; left < footprints.length; left += 1) {
    for (let right = left + 1; right < footprints.length; right += 1) {
      const leftFiles = new Set(footprints[left]!.importerFiles);
      const rightFiles = footprints[right]!.importerFiles;
      if (rightFiles.length > 0 && leftFiles.size > 0 && !rightFiles.some((file) => leftFiles.has(file))) {
        disjointImporterPairs += 1;
      }
    }
  }

  return {
    moduleFile: change.filePath,
    newExports,
    existingExports: before,
    footprints,
    disjointImporterPairs,
  };
}
