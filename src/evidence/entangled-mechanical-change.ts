import type { Candidate, ProjectFile, SourceFile } from "../types.js";

const MAX_INCLUDED_FILES = 8;
const MAX_HUNKS_PER_FILE = 10;
const MAX_EXCERPT_CHARS = 500;

export type MechanicalHunkKind = "whitespace-only" | "rename-only" | "behavioral" | "unknown";

export type MechanicalHunkEvidence = {
  startLine: number;
  endLine: number;
  kind: MechanicalHunkKind;
  lineCount: number;
  changedExcerpt: string;
};

export type EntangledFileEvidence = {
  filePath: string;
  status: "added" | "modified";
  selection: "anchor" | "touched-module";
  hunks: MechanicalHunkEvidence[];
  mechanicalHunks: number;
  behavioralHunks: number;
  mechanicalLines: number;
  behavioralLines: number;
  interleaved: boolean;
};

export type EntangledMechanicalChangeEvidence = {
  anchorFile: string;
  coverage: {
    totalFiles: number;
    includedFiles: number;
    omittedFiles: number;
    includedFilePaths: string[];
    omittedFilePaths: string[];
    unclassifiableFiles: string[];
  };
  totals: {
    mechanicalHunks: number;
    behavioralHunks: number;
    mechanicalLines: number;
    behavioralLines: number;
  };
  files: EntangledFileEvidence[];
};

const KEYWORDS = new Set([
  "break", "case", "catch", "class", "const", "continue", "debugger", "default",
  "delete", "do", "else", "enum", "export", "extends", "false", "finally",
  "for", "function", "if", "import", "in", "instanceof", "interface", "let",
  "new", "null", "return", "super", "switch", "this", "throw", "true",
  "try", "type", "typeof", "undefined", "var", "void", "while", "with",
  "yield", "async", "await", "from", "as", "satisfies", "readonly",
  "string", "number", "boolean", "object", "any", "unknown", "never",
]);

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

function stripWhitespace(text: string): string {
  return text.replace(/\s+/g, "");
}

function normalizeIdentifiers(stripped: string): string {
  return stripped.replace(/[A-Za-z_$][\w$]*/g, (token) => (KEYWORDS.has(token) ? token : "§"));
}

function classifyHunk(hunkLines: string[], oldSource: string): MechanicalHunkKind {
  const stripped = stripWhitespace(hunkLines.join("\n"));
  if (stripped === "") return "whitespace-only";
  const oldStripped = stripWhitespace(oldSource);
  if (oldStripped.includes(stripped)) return "whitespace-only";
  if (normalizeIdentifiers(oldStripped).includes(normalizeIdentifiers(stripped))) return "rename-only";
  return "behavioral";
}

function fileEvidence(
  change: SourceFile,
  selection: "anchor" | "touched-module",
): EntangledFileEvidence {
  const lines = change.source.split("\n");
  const hunks = mergedHunks(change.changedLines).slice(0, MAX_HUNKS_PER_FILE).map((hunk) => {
    const hunkLines = lines.slice(Math.max(0, hunk.start - 1), Math.min(lines.length, hunk.end));
    const kind: MechanicalHunkKind = change.oldSource === null
      ? "unknown"
      : classifyHunk(hunkLines, change.oldSource);
    return {
      startLine: hunk.start,
      endLine: hunk.end,
      kind,
      lineCount: hunkLines.length,
      changedExcerpt: hunkLines.join("\n").slice(0, MAX_EXCERPT_CHARS),
    };
  });
  const isMechanical = (hunk: MechanicalHunkEvidence): boolean =>
    hunk.kind === "whitespace-only" || hunk.kind === "rename-only";
  const mechanicalHunks = hunks.filter(isMechanical);
  const behavioralHunks = hunks.filter((hunk) => hunk.kind === "behavioral");
  const kinds = hunks.map((hunk) => (isMechanical(hunk) ? "mechanical" : hunk.kind));
  const interleaved = kinds.some((kind, index) =>
    index > 0 && kind !== "unknown" && kinds[index - 1] !== "unknown" && kinds[index - 1] !== kind);
  return {
    filePath: change.filePath,
    status: change.oldSource === null ? "added" : "modified",
    selection,
    hunks,
    mechanicalHunks: mechanicalHunks.length,
    behavioralHunks: behavioralHunks.length,
    mechanicalLines: mechanicalHunks.reduce((sum, hunk) => sum + hunk.lineCount, 0),
    behavioralLines: behavioralHunks.reduce((sum, hunk) => sum + hunk.lineCount, 0),
    interleaved,
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
  const files = included.map((change) =>
    fileEvidence(change, change.filePath === candidate.filePath ? "anchor" : "touched-module"));
  const unclassifiableFiles = files
    .filter((file) => file.status === "added")
    .map(({ filePath }) => filePath);
  const totals = {
    mechanicalHunks: files.reduce((sum, file) => sum + file.mechanicalHunks, 0),
    behavioralHunks: files.reduce((sum, file) => sum + file.behavioralHunks, 0),
    mechanicalLines: files.reduce((sum, file) => sum + file.mechanicalLines, 0),
    behavioralLines: files.reduce((sum, file) => sum + file.behavioralLines, 0),
  };
  if (totals.mechanicalHunks === 0 || totals.behavioralHunks === 0) return undefined;

  return {
    anchorFile: candidate.filePath,
    coverage: {
      totalFiles: changes.length,
      includedFiles: included.length,
      omittedFiles: omitted.length,
      includedFilePaths: included.map(({ filePath }) => filePath),
      omittedFilePaths: omitted,
      unclassifiableFiles,
    },
    totals,
    files,
  };
}
