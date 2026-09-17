import { parseSync } from "oxc-parser";
import type { Node } from "oxc-parser";
import type { Candidate, ProjectFile, SourceFile } from "../types.js";
import { findFunctionCallers } from "./repository.js";
import type { FunctionCaller } from "./repository.js";

type DeclarationEvidence = {
  kind: string;
  name: string;
};

type ChangedFileEvidence = {
  filePath: string;
  status: "added" | "modified";
  before: string | null;
  after: string;
  beforeDeclarations: DeclarationEvidence[];
  afterDeclarations: DeclarationEvidence[];
};

type CallerChangeEvidence = {
  filePath: string;
  functionName: string;
  before: FunctionCaller[];
  after: FunctionCaller[];
};

export type ComplexityDisplacementEvidence = {
  anchorFile: string;
  coverage: {
    totalFiles: number;
    includedFiles: number;
    omittedFiles: number;
    truncatedFiles: string[];
  };
  files: ChangedFileEvidence[];
  callerChanges: CallerChangeEvidence[];
};

function declarationStatement(statement: Node): Node | null {
  if (statement.type === "ExportNamedDeclaration" || statement.type === "ExportDefaultDeclaration") {
    return statement.declaration;
  }
  return statement;
}

function declarations(filePath: string, source: string): DeclarationEvidence[] {
  const parsed = parseSync(filePath, source, { range: true });
  if (parsed.errors.some((error) => error.severity === "Error")) return [];
  const result: DeclarationEvidence[] = [];
  for (const statement of parsed.program.body) {
    const declaration = declarationStatement(statement);
    if (!declaration) continue;
    if (
      declaration.type === "FunctionDeclaration"
      || declaration.type === "ClassDeclaration"
      || declaration.type === "TSInterfaceDeclaration"
      || declaration.type === "TSTypeAliasDeclaration"
      || declaration.type === "TSEnumDeclaration"
    ) {
      const name = declaration.id?.name;
      if (name) {
        result.push({ kind: declaration.type, name });
      }
      continue;
    }
    if (declaration.type === "VariableDeclaration") {
      for (const item of declaration.declarations) {
        if (item.id.type !== "Identifier") continue;
        result.push({ kind: declaration.type, name: item.id.name });
      }
    }
  }
  return result.slice(0, 30);
}

function beforeProjectFiles(
  projectFiles: ProjectFile[],
  changes: SourceFile[],
): ProjectFile[] {
  const changesByPath = new Map(changes.map((change) => [change.filePath, change]));
  return projectFiles.flatMap((file) => {
    const change = changesByPath.get(file.filePath);
    if (!change) return [file];
    return change.oldSource === null ? [] : [{ filePath: file.filePath, source: change.oldSource }];
  });
}

function callerChanges(
  changes: SourceFile[],
  beforeFiles: ProjectFile[],
  afterFiles: ProjectFile[],
): CallerChangeEvidence[] {
  const result: CallerChangeEvidence[] = [];
  for (const change of changes.slice(0, 8)) {
    const beforeNames = change.oldSource === null
      ? []
      : declarations(change.filePath, change.oldSource)
        .filter(({ kind }) => kind === "FunctionDeclaration")
        .map(({ name }) => name);
    const afterNames = declarations(change.filePath, change.source)
      .filter(({ kind }) => kind === "FunctionDeclaration")
      .map(({ name }) => name);
    for (const functionName of new Set([...beforeNames, ...afterNames])) {
      result.push({
        filePath: change.filePath,
        functionName,
        before: findFunctionCallers(change.filePath, functionName, beforeFiles),
        after: findFunctionCallers(change.filePath, functionName, afterFiles),
      });
    }
  }
  return result.slice(0, 20);
}

export function buildComplexityDisplacementEvidence(
  candidate: Candidate,
  changes: SourceFile[],
  projectFiles: ProjectFile[] = changes.map(({ filePath, source }) => ({ filePath, source })),
): ComplexityDisplacementEvidence | undefined {
  if (candidate.kind !== "change") return undefined;
  if (!changes.some(({ oldSource }) => oldSource !== null)) return undefined;

  const includedChanges = changes.slice(0, 8);
  const previousProjectFiles = beforeProjectFiles(projectFiles, changes);
  return {
    anchorFile: candidate.filePath,
    coverage: {
      totalFiles: changes.length,
      includedFiles: includedChanges.length,
      omittedFiles: changes.length - includedChanges.length,
      truncatedFiles: includedChanges
        .filter((change) => change.source.length > 8_000 || (change.oldSource?.length ?? 0) > 8_000)
        .map(({ filePath }) => filePath),
    },
    files: includedChanges.map((change) => ({
      filePath: change.filePath,
      status: change.oldSource === null ? "added" : "modified",
      before: change.oldSource?.slice(0, 8_000) ?? null,
      after: change.source.slice(0, 8_000),
      beforeDeclarations: change.oldSource === null
        ? []
        : declarations(change.filePath, change.oldSource),
      afterDeclarations: declarations(change.filePath, change.source),
    })),
    callerChanges: callerChanges(changes, previousProjectFiles, projectFiles),
  };
}
