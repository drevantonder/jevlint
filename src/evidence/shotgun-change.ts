import { parseCached } from "./parse-cache.js";
import type { Candidate, ProjectFile, SourceFile } from "../types.js";
import { moduleImports, resolveModule } from "./repository.js";

type FileHunkEvidence = {
  filePath: string;
  status: "added" | "modified";
  changedLineCount: number;
  changedExcerpt: string;
};

type SharedIdentifierEvidence = {
  identifier: string;
  filePaths: string[];
};

type SharedDependencyEvidence = {
  source: string;
  filePaths: string[];
};

export type ShotgunChangeEvidence = {
  anchorFile: string;
  coverage: {
    totalFiles: number;
    includedFiles: number;
    filePaths: string[];
  };
  files: FileHunkEvidence[];
  sharedIdentifiers: SharedIdentifierEvidence[];
  sharedDependencies: SharedDependencyEvidence[];
};

const MAX_EXCERPT_CHARS = 1_200;
const MAX_FILES = 12;
const MAX_SHARED_IDENTIFIERS = 30;

const KEYWORDS = new Set([
  "break", "case", "catch", "class", "const", "continue", "debugger", "default",
  "delete", "do", "else", "enum", "export", "extends", "false", "finally",
  "for", "function", "if", "import", "in", "instanceof", "interface", "let",
  "new", "null", "return", "super", "switch", "this", "throw", "true",
  "try", "type", "typeof", "undefined", "var", "void", "while", "with",
  "yield", "async", "await", "from", "as", "satisfies", "readonly",
  "string", "number", "boolean", "object", "any", "unknown", "never",
]);

function changedLinesOf(change: SourceFile): string[] {
  const lines = change.source.split("\n");
  return change.changedLines.flatMap(({ start, end }) =>
    lines.slice(Math.max(0, start - 1), Math.min(lines.length, end))
  );
}

function identifiersIn(lines: string[]): Set<string> {
  const result = new Set<string>();
  for (const line of lines) {
    for (const match of line.matchAll(/[A-Za-z_$][\w$]*/g)) {
      const token = match[0];
      if (token.length >= 3 && !KEYWORDS.has(token)) result.add(token);
    }
  }
  return result;
}

export function buildShotgunChangeEvidence(
  candidate: Candidate,
  changes: SourceFile[],
  projectFiles: ProjectFile[] = changes.map(({ filePath, source }) => ({ filePath, source })),
): ShotgunChangeEvidence | undefined {
  if (candidate.kind !== "change") return undefined;
  if (changes.length < 2) return undefined;

  const included = [...changes]
    .sort((left, right) => {
      if (left.filePath === candidate.filePath) return -1;
      if (right.filePath === candidate.filePath) return 1;
      return left.filePath.localeCompare(right.filePath);
    })
    .slice(0, MAX_FILES);

  const perFileIdentifiers = included.map((change) => identifiersIn(changedLinesOf(change)));
  const fileCountByIdentifier = new Map<string, Set<string>>();
  included.forEach((change, index) => {
    for (const identifier of perFileIdentifiers[index] ?? new Set<string>()) {
      const files = fileCountByIdentifier.get(identifier) ?? new Set<string>();
      files.add(change.filePath);
      fileCountByIdentifier.set(identifier, files);
    }
  });
  const sharedIdentifiers = [...fileCountByIdentifier.entries()]
    .filter(([, files]) => files.size >= 2)
    .map(([identifier, files]): SharedIdentifierEvidence => ({
      identifier,
      filePaths: [...files].sort(),
    }))
    .sort((left, right) =>
      right.filePaths.length - left.filePaths.length
      || left.identifier.localeCompare(right.identifier)
    )
    .slice(0, MAX_SHARED_IDENTIFIERS);

  const filesByDependency = new Map<string, Set<string>>();
  for (const change of included) {
    const projectFile = projectFiles.find((file) => file.filePath === change.filePath);
    if (!projectFile) continue;
    const parsed = parseCached(projectFile.filePath, projectFile.source);
    if (parsed.errors.some((error) => error.severity === "Error")) continue;
    for (const imported of moduleImports(parsed.program)) {
      const resolved = resolveModule(change.filePath, imported.source, projectFiles);
      if (!resolved) continue;
      const files = filesByDependency.get(resolved.filePath) ?? new Set<string>();
      files.add(change.filePath);
      filesByDependency.set(resolved.filePath, files);
    }
  }
  const sharedDependencies = [...filesByDependency.entries()]
    .filter(([, files]) => files.size >= 2)
    .map(([source, files]): SharedDependencyEvidence => ({
      source,
      filePaths: [...files].sort(),
    }))
    .sort((left, right) =>
      right.filePaths.length - left.filePaths.length
      || left.source.localeCompare(right.source)
    )
    .slice(0, MAX_SHARED_IDENTIFIERS);

  return {
    anchorFile: candidate.filePath,
    coverage: {
      totalFiles: changes.length,
      includedFiles: included.length,
      filePaths: included.map(({ filePath }) => filePath),
    },
    files: included.map((change): FileHunkEvidence => {
      const lines = changedLinesOf(change);
      const excerpt = lines.join("\n").slice(0, MAX_EXCERPT_CHARS);
      return {
        filePath: change.filePath,
        status: change.oldSource === null ? "added" : "modified",
        changedLineCount: lines.length,
        changedExcerpt: excerpt,
      };
    }),
    sharedIdentifiers,
    sharedDependencies,
  };
}
