import { parseCached } from "./parse-cache.js";
import type { Program } from "oxc-parser";
import type { Candidate, ProjectFile, SourceFile } from "../types.js";
import {
  findFunctionCallersWithCoverage,
  isFunctionExported,
} from "./repository.js";
import type { FunctionCaller, FunctionNode } from "./repository.js";

const MAX_EDITS = 8;
const MAX_CALLERS_PER_EDIT = 10;

export type FanInEdit = {
  filePath: string;
  name: string;
  exported: boolean;
  fanInTotal: number;
  distinctFiles: number;
  callers: FunctionCaller[];
};

export type WideFanInEditEvidence = {
  anchorFile: string;
  coverage: {
    totalFiles: number;
    comparedFiles: number;
  };
  editedFunctions: FanInEdit[];
};

function normalizeBody(text: string): string {
  return text.replace(/\s+/g, " ").trim();
}

function bodyText(source: string, fn: FunctionNode): string {
  if (fn.body === null || fn.body === undefined) return "";
  return normalizeBody(source.slice(fn.body.start, fn.body.end));
}

function namedFunctions(program: Program): Map<string, FunctionNode> {
  const result = new Map<string, FunctionNode>();
  for (const statement of program.body) {
    const declaration = statement.type === "ExportNamedDeclaration"
      ? statement.declaration
      : statement;
    if (declaration?.type === "FunctionDeclaration" && declaration.id?.name) {
      if (!result.has(declaration.id.name)) result.set(declaration.id.name, declaration);
      continue;
    }
    if (declaration?.type !== "VariableDeclaration") continue;
    for (const item of declaration.declarations) {
      if (item.id.type !== "Identifier" || !item.init) continue;
      if (
        item.init.type !== "ArrowFunctionExpression"
        && item.init.type !== "FunctionExpression"
      ) continue;
      if (!result.has(item.id.name)) result.set(item.id.name, item.init);
    }
  }
  return result;
}

function exportedNames(program: Program): Set<string> {
  const names = new Set<string>();
  for (const statement of program.body) {
    if (statement.type !== "ExportNamedDeclaration") continue;
    const declaration = statement.declaration;
    if (declaration?.type === "FunctionDeclaration" && declaration.id?.name) {
      names.add(declaration.id.name);
    }
    if (declaration?.type === "VariableDeclaration") {
      for (const item of declaration.declarations) {
        if (item.id.type === "Identifier") names.add(item.id.name);
      }
    }
    for (const specifier of statement.specifiers) {
      if (specifier.local.type === "Identifier") names.add(specifier.local.name);
    }
  }
  return names;
}

export function buildWideFanInEditEvidence(
  candidate: Candidate,
  changes: SourceFile[],
  projectFiles: ProjectFile[] = changes.map(({ filePath, source }) => ({ filePath, source })),
): WideFanInEditEvidence | undefined {
  if (candidate.kind !== "change") return undefined;
  const editedFunctions: FanInEdit[] = [];
  let compared = 0;

  const ordered = [...changes].sort((left, right) => {
    if (left.filePath === candidate.filePath) return -1;
    if (right.filePath === candidate.filePath) return 1;
    return left.filePath.localeCompare(right.filePath);
  });

  for (const change of ordered) {
    if (editedFunctions.length >= MAX_EDITS) break;
    if (change.oldSource === null) continue;
    const beforeParsed = parseCached(change.filePath, change.oldSource);
    const afterParsed = parseCached(change.filePath, change.source);
    if (
      beforeParsed.errors.some((error) => error.severity === "Error")
      || afterParsed.errors.some((error) => error.severity === "Error")
    ) continue;
    compared += 1;
    const before = namedFunctions(beforeParsed.program);
    const after = namedFunctions(afterParsed.program);
    const exported = exportedNames(afterParsed.program);

    for (const [name, afterNode] of after) {
      if (editedFunctions.length >= MAX_EDITS) break;
      const beforeNode = before.get(name);
      // Added or removed functions are surface changes, not edits to a
      // behavior existing callers already depend on.
      if (!beforeNode) continue;
      if (bodyText(change.source, afterNode) === bodyText(change.oldSource, beforeNode)) continue;
      const coverage = findFunctionCallersWithCoverage(change.filePath, name, projectFiles);
      // No callers means no ripple; the proposition is vacuous.
      if (coverage.total === 0) continue;
      editedFunctions.push({
        filePath: change.filePath,
        name,
        exported: exported.has(name)
          || isFunctionExported(afterParsed.program, afterNode, name),
        fanInTotal: coverage.total,
        distinctFiles: new Set(coverage.callers.map(({ filePath }) => filePath)).size,
        callers: coverage.callers.slice(0, MAX_CALLERS_PER_EDIT),
      });
    }
  }

  if (editedFunctions.length === 0) return undefined;
  return {
    anchorFile: candidate.filePath,
    coverage: {
      totalFiles: changes.length,
      comparedFiles: compared,
    },
    editedFunctions,
  };
}
