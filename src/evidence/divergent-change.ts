import { parseSync, Visitor } from "oxc-parser";
import type { CallExpression, Class, Node } from "oxc-parser";
import type { Candidate, ProjectFile, SourceFile } from "../types.js";
import { findFunctionCallersWithCoverage } from "./repository.js";

const MAX_INCLUDED_FILES = 8;
const MAX_HUNKS_PER_FILE = 10;
const MAX_DECLARATIONS_PER_FILE = 10;
const MAX_CALLERS_PER_DECLARATION = 2;
const MAX_CALL_CHARS = 240;

type DeclarationRange = {
  kind: string;
  name: string;
  startLine: number;
  endLine: number;
};

type HunkEvidence = {
  startLine: number;
  endLine: number;
  declarations: string[];
  identifiers: string[];
};

type DeclarationCallerEvidence = {
  name: string;
  kind: string;
  totalCallers: number;
  callerFiles: string[];
  sampleCalls: string[];
};

export type DivergentModuleEvidence = {
  filePath: string;
  status: "added" | "modified";
  selection: "anchor" | "touched-module";
  hunks: HunkEvidence[];
  disjointHunks: boolean;
  crossHunkIdentifiers: string[];
  touchedDeclarations: DeclarationCallerEvidence[];
};

export type DivergentChangeEvidence = {
  anchorFile: string;
  coverage: {
    totalFiles: number;
    includedFiles: number;
    omittedFiles: number;
    includedFilePaths: string[];
    omittedFilePaths: string[];
  };
  modules: DivergentModuleEvidence[];
};

function lineStarts(source: string): number[] {
  const starts = [0];
  for (let index = 0; index < source.length; index += 1) {
    if (source[index] === "\n") starts.push(index + 1);
  }
  return starts;
}

function lineAt(starts: number[], offset: number): number {
  let line = 1;
  for (let index = 0; index < starts.length; index += 1) {
    if ((starts[index] ?? 0) <= offset) line = index + 1;
    else break;
  }
  return line;
}

function declarationStatement(statement: Node): Node | null {
  if (statement.type === "ExportNamedDeclaration" || statement.type === "ExportDefaultDeclaration") {
    return statement.declaration;
  }
  return statement;
}

function memberKey(member: Class["body"]["body"][number]): string | undefined {
  if (member.type !== "MethodDefinition" && member.type !== "PropertyDefinition") return undefined;
  const key = member.key;
  if (key.type === "Identifier") return key.name;
  if (key.type === "PrivateIdentifier") return `#${key.name}`;
  return undefined;
}

function parsedDeclarationRanges(filePath: string, source: string): DeclarationRange[] {
  const parsed = parseSync(filePath, source, { range: true });
  if (parsed.errors.some((error) => error.severity === "Error")) return [];
  const starts = lineStarts(source);
  const result: DeclarationRange[] = [];
  for (const statement of parsed.program.body) {
    const declaration = declarationStatement(statement);
    if (!declaration) continue;
    const range = {
      startLine: lineAt(starts, statement.start),
      endLine: lineAt(starts, statement.end),
    };
    if (
      declaration.type === "FunctionDeclaration"
      || declaration.type === "TSInterfaceDeclaration"
      || declaration.type === "TSTypeAliasDeclaration"
      || declaration.type === "TSEnumDeclaration"
    ) {
      const name = declaration.id?.name;
      if (name) result.push({ kind: declaration.type, name, ...range });
      continue;
    }
    if (declaration.type === "ClassDeclaration") {
      const className = declaration.id?.name ?? "anonymous class";
      result.push({ kind: declaration.type, name: className, ...range });
      for (const member of declaration.body.body) {
        if (member.type !== "MethodDefinition" && member.type !== "PropertyDefinition") continue;
        const key = memberKey(member);
        if (!key || key === "constructor") continue;
        result.push({
          kind: `${declaration.type}.${member.type}`,
          name: `${className}.${key}`,
          startLine: lineAt(starts, member.start),
          endLine: lineAt(starts, member.end),
        });
      }
      continue;
    }
    if (declaration.type === "VariableDeclaration") {
      for (const item of declaration.declarations) {
        if (item.id.type !== "Identifier") continue;
        result.push({ kind: declaration.type, name: item.id.name, ...range });
      }
    }
  }
  return result;
}

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

function declarationsForHunk(
  declarations: DeclarationRange[],
  hunk: { start: number; end: number },
): string[] {
  const overlapping = declarations
    .filter(({ startLine, endLine }) => startLine <= hunk.end && endLine >= hunk.start);
  const members = overlapping.filter(({ name }) => name.includes("."));
  const selected = members.length > 0 ? members : overlapping;
  return selected.map(({ name }) => name);
}

const IDENTIFIER_STOPWORDS = new Set([
  "this", "super", "new", "return", "const", "let", "var", "function", "class",
  "extends", "import", "export", "from", "if", "else", "for", "while", "throw",
  "void", "typeof", "true", "false", "null", "undefined", "number", "string",
  "boolean", "void",
]);

function identifiersForHunk(
  filePath: string,
  source: string,
  hunk: { start: number; end: number },
): string[] {
  const parsed = parseSync(filePath, source, { range: true });
  if (parsed.errors.some((error) => error.severity === "Error")) return [];
  const starts = lineStarts(source);
  const names = new Set<string>();
  new Visitor({
    Identifier(node) {
      const line = lineAt(starts, node.start);
      if (line < hunk.start || line > hunk.end) return;
      if (node.name.length < 3 || IDENTIFIER_STOPWORDS.has(node.name)) return;
      names.add(node.name);
    },
  }).visit(parsed.program);
  return [...names].sort((left, right) => left.localeCompare(right));
}

function crossHunkIdentifiers(hunks: HunkEvidence[]): string[] {
  const counts = new Map<string, number>();
  for (const hunk of hunks) {
    for (const name of new Set(hunk.identifiers)) {
      counts.set(name, (counts.get(name) ?? 0) + 1);
    }
  }
  return [...counts]
    .filter(([, count]) => count >= 2)
    .map(([name]) => name)
    .sort((left, right) => left.localeCompare(right));
}

function declarationCallers(
  name: string,
  filePath: string,
  projectFiles: ProjectFile[],
): DeclarationCallerEvidence {
  const local = name.includes(".") ? name.split(".").at(-1) ?? name : name;
  if (!name.includes(".")) {
    const coverage = findFunctionCallersWithCoverage(filePath, local, projectFiles);
    const callers = coverage.callers.slice(0, MAX_CALLERS_PER_DECLARATION);
    return {
      name,
      kind: "function-or-value",
      totalCallers: coverage.total,
      callerFiles: [...new Set(callers.map(({ filePath: caller }) => caller))],
      sampleCalls: callers.map(({ call }) => call.slice(0, MAX_CALL_CHARS)),
    };
  }
  const callerFiles = new Set<string>();
  const sampleCalls: string[] = [];
  let total = 0;
  for (const file of projectFiles) {
    const parsed = parseSync(file.filePath, file.source, { range: true });
    if (parsed.errors.some((error) => error.severity === "Error")) continue;
    new Visitor({
      CallExpression(call: CallExpression) {
        const callee = call.callee;
        if (
          callee.type !== "MemberExpression"
          || callee.computed
          || callee.property.type !== "Identifier"
          || callee.property.name !== local
        ) return;
        total += 1;
        callerFiles.add(file.filePath);
        if (sampleCalls.length < MAX_CALLERS_PER_DECLARATION) {
          sampleCalls.push(file.source.slice(call.start, call.end).slice(0, MAX_CALL_CHARS));
        }
      },
    }).visit(parsed.program);
  }
  return {
    name,
    kind: "class-member",
    totalCallers: total,
    callerFiles: [...callerFiles].slice(0, MAX_CALLERS_PER_DECLARATION),
    sampleCalls,
  };
}

function moduleEvidence(
  change: SourceFile,
  selection: "anchor" | "touched-module",
  projectFiles: ProjectFile[],
): DivergentModuleEvidence {
  const declarations = parsedDeclarationRanges(change.filePath, change.source);
  const hunks = mergedHunks(change.changedLines).slice(0, MAX_HUNKS_PER_FILE).map((hunk) => ({
    startLine: hunk.start,
    endLine: hunk.end,
    declarations: declarationsForHunk(declarations, hunk),
    identifiers: identifiersForHunk(change.filePath, change.source, hunk),
  }));
  const touched = [...new Set(hunks.flatMap(({ declarations: names }) => names))]
    .slice(0, MAX_DECLARATIONS_PER_FILE);
  const hunkSets = hunks.map(({ declarations: names }) => new Set(names));
  const disjointHunks = hunkSets.every((left, leftIndex) =>
    hunkSets.every((right, rightIndex) =>
      leftIndex >= rightIndex
      || [...left].every((name) => !right.has(name))
    )
  ) && hunkSets.some((set) => set.size > 0);
  return {
    filePath: change.filePath,
    status: change.oldSource === null ? "added" : "modified",
    selection,
    hunks,
    disjointHunks,
    crossHunkIdentifiers: crossHunkIdentifiers(hunks),
    touchedDeclarations: touched.map((name) => declarationCallers(name, change.filePath, projectFiles)),
  };
}

export function buildDivergentChangeEvidence(
  candidate: Candidate,
  changes: SourceFile[],
  projectFiles: ProjectFile[] = changes.map(({ filePath, source }) => ({ filePath, source })),
): DivergentChangeEvidence | undefined {
  if (candidate.kind !== "change") return undefined;
  if (changes.length === 0) return undefined;

  const prioritized = [...changes].sort((left, right) => {
    if (left.filePath === candidate.filePath) return -1;
    if (right.filePath === candidate.filePath) return 1;
    return left.filePath.localeCompare(right.filePath);
  });
  const included = prioritized.slice(0, MAX_INCLUDED_FILES);
  const omitted = prioritized.slice(MAX_INCLUDED_FILES).map(({ filePath }) => filePath);
  const modules = included.map((change) =>
    moduleEvidence(
      change,
      change.filePath === candidate.filePath ? "anchor" : "touched-module",
      projectFiles,
    )
  );
  const anchorDivergent = modules.some((module) =>
    module.selection === "anchor"
    && module.status === "modified"
    && module.hunks.length >= 2
    && module.disjointHunks
    && module.touchedDeclarations.length >= 2
  );
  if (!anchorDivergent) return undefined;

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
