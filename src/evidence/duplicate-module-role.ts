import { posix } from "node:path";
import { parseCached } from "./parse-cache.js";
import type { ModuleExportName } from "oxc-parser";
import type { Candidate, ProjectFile, SourceFile } from "../types.js";
import { findModuleImporters } from "./repository.js";

export type TwinModule = {
  filePath: string;
  sharedExportNames: string[];
  nameSimilarity: number;
  newFileImporters: string[];
  twinImporters: string[];
  platformVariant: boolean;
};

export type DuplicateModuleRoleEvidence = {
  newFile: string;
  newExports: string[];
  twins: TwinModule[];
};

const MAX_TWINS = 6;
const MAX_EXPORTS = 12;
const PLATFORM_SUFFIX = /\.(ios|android|native|web|node|browser|test|spec|stories)\.[cm]?[jt]sx?$/;

function exportedSpecifierName(exported: ModuleExportName): string {
  return exported.type === "Literal" ? exported.value : exported.name;
}

function exportNames(filePath: string, source: string): string[] | undefined {
  const parsed = parseCached(filePath, source);
  if (parsed.errors.some((error) => error.severity === "Error")) return undefined;
  const names: string[] = [];
  const push = (name: string): void => {
    if (!names.includes(name) && names.length < MAX_EXPORTS) names.push(name);
  };
  for (const statement of parsed.program.body) {
    if (statement.type === "ExportDefaultDeclaration") {
      push("default");
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
  }
  return names;
}

function stemTokens(filePath: string): string[] {
  const stem = posix.basename(filePath).replace(/\.[cm]?[jt]sx?$/, "").toLowerCase();
  return stem.split(/[-_.]+/).filter((token) => token.length > 0);
}

function nameSimilarity(left: string, right: string): number {
  const leftTokens = new Set(stemTokens(left));
  const rightTokens = stemTokens(right);
  if (leftTokens.size === 0 || rightTokens.length === 0) return 0;
  const shared = rightTokens.filter((token) => leftTokens.has(token)).length;
  return shared / Math.max(leftTokens.size, rightTokens.length);
}

export function buildDuplicateModuleRoleEvidence(
  candidate: Candidate,
  changes: SourceFile[],
  projectFiles: ProjectFile[] = changes.map(({ filePath, source }) => ({ filePath, source })),
): DuplicateModuleRoleEvidence | undefined {
  if (candidate.kind !== "change") return undefined;
  const change = changes.find(({ filePath }) => filePath === candidate.filePath);
  if (!change || change.oldSource !== null) return undefined;
  const newExports = exportNames(change.filePath, change.source);
  if (!newExports || newExports.length === 0) return undefined;

  const directory = posix.dirname(change.filePath);
  const twins: TwinModule[] = [];
  for (const file of projectFiles) {
    if (twins.length >= MAX_TWINS) break;
    if (file.filePath === change.filePath) continue;
    if (posix.dirname(file.filePath) !== directory) continue;
    const siblingExports = exportNames(file.filePath, file.source);
    if (!siblingExports) continue;
    const shared = siblingExports.filter((name) => newExports.includes(name));
    const similarity = nameSimilarity(change.filePath, file.filePath);
    if (shared.length === 0 && similarity === 0) continue;
    const newImporters = findModuleImporters(change.filePath, projectFiles).map(({ filePath }) => filePath);
    const twinImporters = findModuleImporters(file.filePath, projectFiles).map(({ filePath }) => filePath);
    twins.push({
      filePath: file.filePath,
      sharedExportNames: shared.slice(0, MAX_EXPORTS),
      nameSimilarity: Math.round(similarity * 100) / 100,
      newFileImporters: newImporters.slice(0, 8),
      twinImporters: twinImporters.slice(0, 8),
      platformVariant: PLATFORM_SUFFIX.test(change.filePath) || PLATFORM_SUFFIX.test(file.filePath),
    });
  }
  if (twins.length === 0) return undefined;

  return { newFile: change.filePath, newExports, twins };
}
