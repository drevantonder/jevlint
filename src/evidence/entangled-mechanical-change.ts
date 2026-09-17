import { parseSync } from "oxc-parser";
import type { Candidate, ProjectFile, SourceFile } from "../types.js";

const MAX_INCLUDED_FILES = 8;
const MAX_HUNKS_PER_FILE = 10;

export type EntangledHunkEvidence = {
  startLine: number;
  endLine: number;
  mechanicalLines: number;
  semanticLines: number;
  entangled: boolean;
};

export type EntangledModuleEvidence = {
  filePath: string;
  status: "added" | "modified";
  selection: "anchor" | "touched-module";
  hunks: EntangledHunkEvidence[];
  entangledHunks: number;
  mechanicalTotal: number;
  semanticTotal: number;
};

export type EntangledMechanicalChangeEvidence = {
  anchorFile: string;
  coverage: {
    totalFiles: number;
    includedFiles: number;
    omittedFiles: number;
    includedFilePaths: string[];
    omittedFilePaths: string[];
  };
  modules: EntangledModuleEvidence[];
};

function mergedHunks(changedLines: SourceFile["changedLines"]): Array<{ start: number; end: number }> {
  const sorted = [...changedLines].sort((left, right) => left.start - right.start || left.end - right.end);
  const hunks: Array<{ start: number; end: number }> = [];
  for (const range of sorted) {
    const current = hunks.at(-1);
    if (current && range.start <= current.end + 1) {
      current.end = Math.max(current.end, range.end);
    } else {
      hunks.push({ start: range.start, end: range.end });
    }
  }
  return hunks;
}

function cosmetic(line: string): string {
  return line
    .replace(/\s+/g, "")
    .replace(/"/g, "'")
    .replace(/;/g, "")
    .replace(/,([}\])])/g, "$1");
}

type LineTokens = {
  idents: string[];
  literals: string[];
  skeleton: string;
};

function tokenize(line: string): LineTokens {
  const literals: string[] = [];
  const withoutStrings = line.replace(
    /'(?:[^'\\]|\\.)*'|"(?:[^"\\]|\\.)*"|`(?:[^`\\]|\\.)*'/g,
    (match) => {
      literals.push(match);
      return "";
    },
  );
  const idents: string[] = [];
  const skeleton = withoutStrings.replace(/[A-Za-z_$][\w$]*/g, (match) => {
    idents.push(match);
    return "#";
  });
  return { idents, literals, skeleton };
}

function arraysEqual(left: string[], right: string[]): boolean {
  return left.length === right.length && left.every((value, index) => value === right[index]);
}

function isRenamePair(removed: string, added: string): boolean {
  if (removed === added) return false;
  const left = tokenize(removed);
  const right = tokenize(added);
  return left.skeleton === right.skeleton
    && arraysEqual(left.literals, right.literals)
    && left.idents.length === right.idents.length
    && !arraysEqual(left.idents, right.idents);
}

function takeMatch(pool: string[], predicate: (line: string) => boolean): string | undefined {
  const index = pool.findIndex(predicate);
  if (index < 0) return undefined;
  const [match] = pool.splice(index, 1);
  return match;
}

export type HunkLayerCounts = {
  mechanical: number;
  semantic: number;
};

function longestCommonSubsequence(left: string[], right: string[]): Set<string> {
  const rows = left.length + 1;
  const columns = right.length + 1;
  const lengths: number[] = Array.from({ length: rows * columns }, () => 0);
  const at = (row: number, column: number): number => lengths[row * columns + column] ?? 0;
  for (let row = left.length - 1; row >= 0; row -= 1) {
    for (let column = right.length - 1; column >= 0; column -= 1) {
      lengths[row * columns + column] = left[row] === right[column]
        ? 1 + at(row + 1, column + 1)
        : Math.max(at(row + 1, column), at(row, column + 1));
    }
  }
  const kept = new Set<string>();
  let row = 0;
  let column = 0;
  while (row < left.length && column < right.length) {
    if (left[row] === right[column]) {
      kept.add(`${row}:${left[row]}`);
      row += 1;
      column += 1;
    } else if (at(row + 1, column) >= at(row, column + 1)) {
      row += 1;
    } else {
      column += 1;
    }
  }
  return kept;
}

function classifyHunk(oldSlice: string[], newSlice: string[]): HunkLayerCounts {
  const oldPool = oldSlice.map((line) => line.trim());
  const newPool = newSlice.map((line) => line.trim());
  const kept = longestCommonSubsequence(oldPool, newPool);

  const removed: string[] = [];
  oldPool.forEach((line, index) => {
    if (!kept.has(`${index}:${line}`)) removed.push(line);
  });
  const added: string[] = [];
  const newKeptCounts = new Map<string, number>();
  for (const key of kept) {
    const line = key.slice(key.indexOf(":") + 1);
    newKeptCounts.set(line, (newKeptCounts.get(line) ?? 0) + 1);
  }
  for (const line of newPool) {
    const remaining = newKeptCounts.get(line) ?? 0;
    if (remaining > 0) newKeptCounts.set(line, remaining - 1);
    else added.push(line);
  }

  let mechanical = 0;

  const extractBlanks = (pool: string[]): number => {
    let count = 0;
    for (let index = pool.length - 1; index >= 0; index -= 1) {
      if (pool[index] === "") {
        pool.splice(index, 1);
        count += 1;
      }
    }
    return count;
  };
  mechanical += extractBlanks(removed) + extractBlanks(added);

  for (let index = removed.length - 1; index >= 0; index -= 1) {
    const match = takeMatch(added, (candidate) => candidate === removed[index]);
    if (match !== undefined) {
      removed.splice(index, 1);
      mechanical += 2;
    }
  }

  for (let index = removed.length - 1; index >= 0; index -= 1) {
    const current = removed[index];
    if (current === undefined) continue;
    const match = takeMatch(added, (candidate) => cosmetic(candidate) === cosmetic(current));
    if (match !== undefined) {
      removed.splice(index, 1);
      mechanical += 2;
    }
  }

  for (let index = removed.length - 1; index >= 0; index -= 1) {
    const current = removed[index];
    if (current === undefined) continue;
    const match = takeMatch(added, (candidate) => isRenamePair(current, candidate));
    if (match !== undefined) {
      removed.splice(index, 1);
      mechanical += 2;
    }
  }

  return { mechanical, semantic: removed.length + added.length };
}

function moduleEvidence(
  change: SourceFile,
  selection: "anchor" | "touched-module",
): EntangledModuleEvidence | undefined {
  if (change.oldSource === null) return undefined;
  const parsed = parseSync(change.filePath, change.source, { range: true });
  if (parsed.errors.some((error) => error.severity === "Error")) return undefined;
  const oldLines = change.oldSource.split("\n");
  const newLines = change.source.split("\n");
  const hunks = mergedHunks(change.changedLines).slice(0, MAX_HUNKS_PER_FILE).map((hunk) => {
    const start = Math.max(1, hunk.start);
    const end = Math.max(start, hunk.end);
    const { mechanical, semantic } = classifyHunk(
      oldLines.slice(start - 1, end),
      newLines.slice(start - 1, end),
    );
    return {
      startLine: start,
      endLine: end,
      mechanicalLines: mechanical,
      semanticLines: semantic,
      entangled: mechanical > 0 && semantic > 0,
    };
  });
  return {
    filePath: change.filePath,
    status: "modified",
    selection,
    hunks,
    entangledHunks: hunks.filter(({ entangled }) => entangled).length,
    mechanicalTotal: hunks.reduce((total, hunk) => total + hunk.mechanicalLines, 0),
    semanticTotal: hunks.reduce((total, hunk) => total + hunk.semanticLines, 0),
  };
}

export function buildEntangledMechanicalChangeEvidence(
  candidate: Candidate,
  changes: SourceFile[],
  projectFiles: ProjectFile[] = changes.map(({ filePath, source }) => ({ filePath, source })),
): EntangledMechanicalChangeEvidence | undefined {
  void projectFiles;
  if (candidate.kind !== "change") return undefined;
  if (changes.length === 0) return undefined;

  const prioritized = [...changes].sort((left, right) => {
    if (left.filePath === candidate.filePath) return -1;
    if (right.filePath === candidate.filePath) return 1;
    return left.filePath.localeCompare(right.filePath);
  });
  const included = prioritized.slice(0, MAX_INCLUDED_FILES);
  const omitted = prioritized.slice(MAX_INCLUDED_FILES).map(({ filePath }) => filePath);
  const modules = included.flatMap((change) => {
    const evidence = moduleEvidence(
      change,
      change.filePath === candidate.filePath ? "anchor" : "touched-module",
    );
    return evidence ? [evidence] : [];
  });
  if (!modules.some((module) => module.entangledHunks > 0)) return undefined;

  return {
    anchorFile: candidate.filePath,
    coverage: {
      totalFiles: changes.length,
      includedFiles: included.length,
      omittedFiles: omitted.length,
      includedFilePaths: included.map(({ filePath }) => filePath),
      omittedFilePaths: omitted,
    },
    modules,
  };
}
