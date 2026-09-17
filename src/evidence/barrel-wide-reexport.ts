import { parseSync } from "oxc-parser";
import type { Candidate, ProjectFile, SourceFile } from "../types.js";
import { findModuleImporters, resolveModule } from "./repository.js";

export type BarrelReExportAddition = {
  statement: string;
  target: string;
  resolved: string | null;
  owningDirectory: string | null;
  importerCount: number;
  wildcard: boolean;
};

export type BarrelWideReexportEvidence = {
  barrelFile: string;
  additions: BarrelReExportAddition[];
  distinctDirectories: number;
};

const BARREL_PATTERN = /(^|\/)index\.[cm]?[jt]sx?$/;
const MAX_ADDITIONS = 10;
const MAX_STATEMENT_CHARS = 300;

function lineAt(source: string, offset: number): number {
  let line = 1;
  for (let index = 0; index < offset; index += 1) {
    if (source[index] === "\n") line += 1;
  }
  return line;
}

function owningDirectory(filePath: string): string {
  const parts = filePath.split("/");
  parts.pop();
  return parts.join("/") || ".";
}

export function buildBarrelWideReexportEvidence(
  candidate: Candidate,
  changes: SourceFile[],
  projectFiles: ProjectFile[] = changes.map(({ filePath, source }) => ({ filePath, source })),
): BarrelWideReexportEvidence | undefined {
  if (candidate.kind !== "change") return undefined;
  if (!BARREL_PATTERN.test(candidate.filePath)) return undefined;
  const change = changes.find(({ filePath }) => filePath === candidate.filePath);
  if (!change) return undefined;
  const parsed = parseSync(change.filePath, change.source, { range: true });
  if (parsed.errors.some((error) => error.severity === "Error")) return undefined;

  const changedLines = new Set<number>();
  for (const range of change.changedLines) {
    for (let line = range.start; line <= range.end; line += 1) changedLines.add(line);
  }

  const additions: BarrelReExportAddition[] = [];
  for (const statement of parsed.program.body) {
    if (additions.length >= MAX_ADDITIONS) break;
    let target: string | null = null;
    let wildcard = false;
    if (statement.type === "ExportAllDeclaration") {
      target = statement.source.value;
      wildcard = true;
    } else if (statement.type === "ExportNamedDeclaration" && statement.source) {
      target = statement.source.value;
    }
    if (target === null) continue;
    if (!changedLines.has(lineAt(change.source, statement.start))) continue;
    const resolved = resolveModule(change.filePath, target, projectFiles);
    additions.push({
      statement: change.source.slice(statement.start, statement.end).slice(0, MAX_STATEMENT_CHARS),
      target,
      resolved: resolved?.filePath ?? null,
      owningDirectory: resolved ? owningDirectory(resolved.filePath) : null,
      importerCount: resolved ? findModuleImporters(resolved.filePath, projectFiles).length : 0,
      wildcard,
    });
  }
  if (additions.length === 0) return undefined;

  return {
    barrelFile: change.filePath,
    additions,
    distinctDirectories: new Set(
      additions.map(({ owningDirectory: directory }) => directory ?? "(unresolved)"),
    ).size,
  };
}
