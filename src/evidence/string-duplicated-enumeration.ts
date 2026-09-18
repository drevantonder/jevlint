import { Visitor } from "oxc-parser";
import { parseCached } from "./parse-cache.js";
import type { Candidate, ProjectFile, SourceFile } from "../types.js";
import { moduleImports, resolveModule } from "./repository.js";

export type ValueSetOwner = {
  filePath: string;
  typeName: string;
  kind: "union" | "enum";
  members: string[];
  sourceExcerpt: string;
};

export type StringDuplicatedEnumerationEvidence = {
  anchorFile: string;
  restatedLiterals: string[];
  changedComparisons: string[];
  canonical: ValueSetOwner;
  sharedLiterals: string[];
  importsOwner: boolean;
};

const STRING_PATTERN = /"([^"\\]{1,60})"|'([^'\\]{1,60})'/g;
const COMPARISON_PATTERN = /===|!==|==|!=|\.includes\(|\.has\(|case\s+["']/;

function literalsIn(lines: string[]): string[] {
  const values = new Set<string>();
  for (const line of lines) {
    if (/import\s|require\(|from\s+["']/.test(line)) continue;
    for (const match of line.matchAll(STRING_PATTERN)) {
      const value = match[1] ?? match[2] ?? "";
      if (value.length === 0 || /^\d+$/.test(value)) continue;
      values.add(value);
    }
  }
  return [...values].sort();
}

function changedLineSet(change: SourceFile): Set<number> {
  const lines = new Set<number>();
  for (const range of change.changedLines) {
    for (let line = range.start; line <= range.end; line += 1) lines.add(line);
  }
  return lines;
}

function changedLinesOf(change: SourceFile): string[] {
  const wanted = changedLineSet(change);
  return change.source.split("\n").filter((_, index) => wanted.has(index + 1));
}

function literalText(raw: string | null): string | undefined {
  if (raw === null) return undefined;
  const first = raw[0];
  const last = raw.at(-1);
  if ((first === "\"" || first === "'") && last === first) return raw.slice(1, -1);
  return raw;
}

function valueSetsIn(file: ProjectFile): ValueSetOwner[] {
  const parsed = parseCached(file.filePath, file.source);
  if (parsed.errors.some((error) => error.severity === "Error")) return [];
  const sets: ValueSetOwner[] = [];
  new Visitor({
    TSTypeAliasDeclaration(node) {
      if (node.typeAnnotation.type !== "TSUnionType") return;
      const members = new Set<string>();
      for (const member of node.typeAnnotation.types) {
        if (member.type === "TSLiteralType" && member.literal.type === "Literal") {
          const value = literalText(member.literal.raw);
          if (value !== undefined) members.add(value);
        }
      }
      if (members.size >= 2) {
        sets.push({
          filePath: file.filePath,
          typeName: node.id.name,
          kind: "union",
          members: [...members].sort(),
          sourceExcerpt: file.source.slice(node.start, node.end).slice(0, 1_000),
        });
      }
    },
    TSEnumDeclaration(node) {
      const members = new Set<string>();
      for (const member of node.body.members) {
        const initializer = member.initializer;
        if (initializer?.type === "Literal") {
          const value = literalText(initializer.raw);
          if (value !== undefined && Number.isNaN(Number(value))) members.add(value);
        }
      }
      if (members.size >= 2) {
        sets.push({
          filePath: file.filePath,
          typeName: node.id.name,
          kind: "enum",
          members: [...members].sort(),
          sourceExcerpt: file.source.slice(node.start, node.end).slice(0, 1_000),
        });
      }
    },
  }).visit(parsed.program);
  return sets;
}

export function buildStringDuplicatedEnumerationEvidence(
  candidate: Candidate,
  changes: SourceFile[],
  projectFiles: ProjectFile[] = changes.map(({ filePath, source }) => ({ filePath, source })),
): StringDuplicatedEnumerationEvidence | undefined {
  if (candidate.kind !== "change") return undefined;
  if (changes.length === 0) return undefined;
  const anchor = changes.find((change) => change.filePath === candidate.filePath) ?? changes[0];
  if (!anchor) return undefined;

  const changed = changedLinesOf(anchor);
  if (changed.length === 0) return undefined;
  const restated = literalsIn(changed);
  if (restated.length < 2) return undefined;
  const wanted = new Set(restated);

  let canonical: ValueSetOwner | undefined;
  let shared: string[] = [];
  for (const file of projectFiles) {
    if (file.filePath === anchor.filePath) continue;
    for (const set of valueSetsIn(file)) {
      const overlap = set.members.filter((member) => wanted.has(member));
      if (overlap.length >= 2 && overlap.length > shared.length) {
        canonical = set;
        shared = overlap;
      }
    }
  }
  if (!canonical) return undefined;

  const anchorFile = projectFiles.find((file) => file.filePath === anchor.filePath);
  let importsOwner = false;
  if (anchorFile) {
    const parsed = parseCached(anchorFile.filePath, anchorFile.source);
    if (!parsed.errors.some((error) => error.severity === "Error")) {
      importsOwner = moduleImports(parsed.program).some(({ source }) => {
        const resolved = resolveModule(anchorFile.filePath, source, projectFiles);
        return resolved?.filePath === canonical?.filePath;
      });
    }
  }

  return {
    anchorFile: anchor.filePath,
    restatedLiterals: restated.slice(0, 12),
    changedComparisons: changed
      .filter((line) => COMPARISON_PATTERN.test(line))
      .map((line) => line.trim().slice(0, 160))
      .slice(0, 8),
    canonical,
    sharedLiterals: [...shared].sort().slice(0, 12),
    importsOwner,
  };
}
