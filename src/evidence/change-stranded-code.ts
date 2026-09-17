import { parseSync } from "oxc-parser";
import type { Program } from "oxc-parser";
import type { Candidate, ProjectFile, SourceFile } from "../types.js";
import {
  findFunctionCallersWithCoverage,
  findModuleImporters,
  isFunctionExported,
  type FunctionNode,
} from "./repository.js";

export type StrandedFunction = {
  name: string;
  filePath: string;
  exported: boolean;
  callersBefore: number;
  callerExcerpts: string[];
  successors: StrandedSuccessor[];
};

export type StrandedSuccessor = {
  name: string;
  filePath: string;
  migratedCallSites: string[];
};

export type StrandedModule = {
  filePath: string;
  importersBefore: number;
  importerFiles: string[];
};

export type ChangeStrandedCodeEvidence = {
  anchorFile: string;
  coverage: {
    totalFiles: number;
    analyzedFiles: number;
  };
  strandedFunctions: StrandedFunction[];
  strandedModules: StrandedModule[];
};

type TopLevelFunction = {
  name: string;
  node: FunctionNode;
};

function topLevelFunctions(program: Program): TopLevelFunction[] {
  const result: TopLevelFunction[] = [];
  for (const statement of program.body) {
    const declaration = statement.type === "ExportNamedDeclaration"
      ? statement.declaration
      : statement.type === "ExportDefaultDeclaration"
        ? statement.declaration
        : statement;
    if (!declaration) continue;
    if (
      (declaration.type === "FunctionDeclaration" || declaration.type === "FunctionExpression")
      && declaration.id?.name
    ) {
      result.push({ name: declaration.id.name, node: declaration });
    }
    if (declaration.type === "VariableDeclaration") {
      for (const item of declaration.declarations) {
        if (item.id.type !== "Identifier") continue;
        if (
          item.init?.type === "ArrowFunctionExpression"
          || item.init?.type === "FunctionExpression"
        ) result.push({ name: item.id.name, node: item.init });
      }
    }
  }
  return result;
}

function parses(filePath: string, source: string): Program | undefined {
  const parsed = parseSync(filePath, source, { range: true });
  if (parsed.errors.some((error) => error.severity === "Error")) return undefined;
  return parsed.program;
}

function nameTokens(name: string): string[] {
  return name
    .split(/(?<=[a-z])(?=[A-Z])|_+|-+|\s+/)
    .map((token) => token.toLowerCase())
    .filter((token) => token.length >= 3);
}

function looksLikeSuccessor(oldName: string, newName: string): boolean {
  if (oldName === newName) return false;
  const oldTokens = new Set(nameTokens(oldName));
  if (oldTokens.size === 0) return false;
  if (nameTokens(newName).some((token) => oldTokens.has(token))) return true;
  const shorter = oldName.length <= newName.length ? oldName : newName;
  const longer = oldName.length <= newName.length ? newName : oldName;
  return shorter.length >= 4 && longer.toLowerCase().includes(shorter.toLowerCase());
}

function containsName(source: string, name: string): boolean {
  return new RegExp(`\\b${name.replace(/\$/g, "\\$")}\\b`).test(source);
}

export function buildChangeStrandedCodeEvidence(
  candidate: Candidate,
  changes: SourceFile[],
  projectFiles: ProjectFile[] = changes.map(({ filePath, source }) => ({ filePath, source })),
): ChangeStrandedCodeEvidence | undefined {
  if (candidate.kind !== "change") return undefined;
  const modified = changes.filter((change) => change.oldSource !== null);
  if (modified.length === 0) return undefined;

  const afterByPath = new Map(projectFiles.map((file) => [file.filePath, file.source]));
  const beforeProject: ProjectFile[] = projectFiles.map((file) => {
    const change = modified.find((entry) => entry.filePath === file.filePath);
    if (!change?.oldSource) return file;
    return { filePath: file.filePath, source: change.oldSource };
  });

  const strandedFunctions: StrandedFunction[] = [];
  const strandedModules: StrandedModule[] = [];
  let analyzedFiles = 0;

  for (const change of modified) {
    const before = change.oldSource ?? "";
    const beforeProgram = parses(change.filePath, before);
    const afterProgram = parses(change.filePath, change.source);
    if (!beforeProgram || !afterProgram) continue;
    analyzedFiles += 1;

    const beforeNames = topLevelFunctions(beforeProgram);
    const afterNames = new Map(topLevelFunctions(afterProgram).map((entry) => [entry.name, entry]));
    const added = [...afterNames.keys()].filter((name) =>
      !beforeNames.some((entry) => entry.name === name)
    );

    for (const { name } of beforeNames) {
      const retained = afterNames.get(name);
      if (!retained) continue;
      const beforeCount = findFunctionCallersWithCoverage(
        change.filePath,
        name,
        beforeProject,
      );
      if (beforeCount.total === 0) continue;
      const afterCount = findFunctionCallersWithCoverage(
        change.filePath,
        name,
        projectFiles,
      );
      if (afterCount.total > 0) continue;
      const successors: StrandedSuccessor[] = added
        .filter((addedName) => looksLikeSuccessor(name, addedName))
        .slice(0, 5)
        .map((addedName): StrandedSuccessor => {
          const migratedCallSites = [...new Set(
            beforeCount.callers.map(({ filePath }) => filePath),
          )]
            .filter((filePath) => containsName(afterByPath.get(filePath) ?? "", addedName))
            .slice(0, 10);
          return { name: addedName, filePath: change.filePath, migratedCallSites };
        });
      strandedFunctions.push({
        name,
        filePath: change.filePath,
        exported: isFunctionExported(afterProgram, retained.node, name),
        callersBefore: beforeCount.total,
        callerExcerpts: beforeCount.callers
          .slice(0, 5)
          .map(({ filePath, line, call }) => `${filePath}:${line}: ${call.slice(0, 160)}`),
        successors,
      });
      if (strandedFunctions.length >= 10) break;
    }

    const importersBefore = findModuleImporters(change.filePath, beforeProject);
    const importersAfter = findModuleImporters(change.filePath, projectFiles);
    if (importersBefore.length > 0 && importersAfter.length === 0 && strandedModules.length < 5) {
      strandedModules.push({
        filePath: change.filePath,
        importersBefore: importersBefore.length,
        importerFiles: importersBefore.map(({ filePath }) => filePath).slice(0, 10),
      });
    }
  }

  if (strandedFunctions.length === 0 && strandedModules.length === 0) return undefined;
  return {
    anchorFile: candidate.filePath,
    coverage: { totalFiles: changes.length, analyzedFiles },
    strandedFunctions: strandedFunctions.slice(0, 10),
    strandedModules,
  };
}
