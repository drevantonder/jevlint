import { Visitor } from "oxc-parser";
import { parseCached } from "./parse-cache.js";
import type { Program } from "oxc-parser";
import type { Candidate, ProjectFile } from "../types.js";
import { functionName } from "./repository.js";
import type { FunctionNode } from "./repository.js";

export type CommentCodeSignals = {
  parseable: boolean;
  needsFunctionWrap: boolean;
  statementKinds: string[];
  statementCount: number;
  balancedBraces: boolean;
  semicolonLines: number;
  keywords: string[];
  hasCall: boolean;
};

export type CommentStaleness = {
  identifiers: string[];
  resolvedCount: number;
  unresolved: string[];
};

export type CommentLiveDuplicate = {
  functionName: string | null;
  sharedIdentifiers: string[];
};

export type CommentedOutImplementationEvidence = {
  comment: {
    filePath: string;
    source: string;
    startLine: number;
    lineCount: number;
  };
  stripped: {
    text: string;
    lineCount: number;
    proseLineCount: number;
  };
  codeSignals: CommentCodeSignals;
  staleness: CommentStaleness;
  liveDuplicate: CommentLiveDuplicate | null;
};

const CODE_KEYWORDS = [
  "return",
  "function",
  "const",
  "let",
  "var",
  "if",
  "else",
  "for",
  "while",
  "do",
  "switch",
  "class",
  "new",
  "import",
  "export",
  "throw",
  "try",
  "catch",
  "await",
  "yield",
  "break",
  "continue",
  "typeof",
  "instanceof",
];

const KEYWORD_PATTERN = new RegExp(`\\b(?:${CODE_KEYWORDS.join("|")})\\b`);

const IDENTIFIER_PATTERN = /\b[A-Za-z_$][\w$]*\b/g;

const JS_KEYWORDS = new Set([
  ...CODE_KEYWORDS,
  "true",
  "false",
  "null",
  "undefined",
  "this",
  "super",
  "void",
  "delete",
  "in",
  "of",
  "case",
  "default",
  "finally",
  "extends",
  "static",
  "get",
  "set",
  "async",
  "from",
  "as",
]);

const CODE_PUNCTUATION = /[;{}()=<>.:[\]]/;

function lineStartOffsets(source: string): number[] {
  const starts = [0];
  for (let index = 0; index < source.length; index += 1) {
    if (source[index] === "\n") starts.push(index + 1);
  }
  return starts;
}

type CommentBlock = {
  text: string;
  start: number;
  end: number;
  startLine: number;
  lineCount: number;
  isFirst: boolean;
};

function commentBlock(source: string, candidate: Candidate): CommentBlock {
  const fallback: CommentBlock = {
    text: candidate.source,
    start: candidate.start,
    end: candidate.end,
    startLine: candidate.startLine,
    lineCount: candidate.source.split("\n").length,
    isFirst: true,
  };
  if (!candidate.source.trimStart().startsWith("//")) return fallback;
  const lines = source.split("\n");
  const starts = lineStartOffsets(source);
  const index = candidate.startLine - 1;
  if ((lines[index] ?? "").trimStart().startsWith("//") === false) return fallback;
  let first = index;
  while (first - 1 >= 0 && (lines[first - 1] ?? "").trimStart().startsWith("//")) first -= 1;
  let last = index;
  while (last + 1 < lines.length && (lines[last + 1] ?? "").trimStart().startsWith("//")) last += 1;
  const start = starts[first] ?? candidate.start;
  const end = (starts[last + 1] ?? source.length + 1) - 1;
  return {
    text: lines.slice(first, last + 1).join("\n"),
    start,
    end: Math.max(end, start),
    startLine: first + 1,
    lineCount: last - first + 1,
    isFirst: first === index,
  };
}

function stripMarkers(source: string): string {
  let text = source.trim();
  if (text.startsWith("/*")) {
    text = text.replace(/^\/\*+/, "").replace(/\*+\/$/, "");
  }
  const lines = text.split("\n").map((line) => {
    let cleaned = line.trim();
    if (cleaned.startsWith("//")) cleaned = cleaned.slice(2);
    else if (cleaned.startsWith("*")) cleaned = cleaned.slice(1);
    return cleaned.trimEnd();
  });
  while (lines.length > 0 && (lines[0] ?? "").trim() === "") lines.shift();
  while (lines.length > 0 && (lines[lines.length - 1] ?? "").trim() === "") lines.pop();
  return lines.join("\n");
}

function statementKinds(program: Program): string[] {
  const kinds: string[] = [];
  const collect = (type: string): (() => void) => () => {
    if (!kinds.includes(type)) kinds.push(type);
  };
  new Visitor({
    VariableDeclaration: collect("VariableDeclaration"),
    FunctionDeclaration: collect("FunctionDeclaration"),
    ExpressionStatement: collect("ExpressionStatement"),
    ReturnStatement: collect("ReturnStatement"),
    IfStatement: collect("IfStatement"),
    ForStatement: collect("ForStatement"),
    WhileStatement: collect("WhileStatement"),
    ClassDeclaration: collect("ClassDeclaration"),
    ImportDeclaration: collect("ImportDeclaration"),
    ExportNamedDeclaration: collect("ExportNamedDeclaration"),
    ThrowStatement: collect("ThrowStatement"),
    TryStatement: collect("TryStatement"),
    SwitchStatement: collect("SwitchStatement"),
  }).visit(program);
  return kinds;
}

function hasCallExpression(program: Program): boolean {
  let found = false;
  new Visitor({
    CallExpression() {
      found = true;
    },
  }).visit(program);
  return found;
}

function tryParse(filePath: string, text: string): Program | undefined {
  const parsed = parseCached(filePath, text);
  if (parsed.errors.some((error) => error.severity === "Error")) return undefined;
  return parsed.program;
}

function identifiers(text: string): string[] {
  const result: string[] = [];
  for (const match of text.matchAll(IDENTIFIER_PATTERN)) {
    const word = match[0];
    if (word.length < 2 || JS_KEYWORDS.has(word)) continue;
    if (!result.includes(word)) result.push(word);
  }
  return result.slice(0, 40);
}

function repoTextExcluding(
  block: CommentBlock,
  owner: ProjectFile,
  projectFiles: ProjectFile[],
): string {
  const parts: string[] = [];
  for (const file of projectFiles) {
    if (file.filePath === owner.filePath) {
      parts.push(
        file.source.slice(0, block.start) + "\n" + file.source.slice(block.end),
      );
    } else {
      parts.push(file.source);
    }
  }
  return parts.join("\n");
}

function liveDuplicate(
  owner: ProjectFile,
  candidate: Candidate,
  names: string[],
): CommentLiveDuplicate | null {
  const parsed = parseCached(owner.filePath, owner.source);
  if (parsed.errors.some((error) => error.severity === "Error")) return null;
  const functions: FunctionNode[] = [];
  new Visitor({
    ArrowFunctionExpression: (node) => functions.push(node),
    FunctionDeclaration: (node) => functions.push(node),
    FunctionExpression: (node) => functions.push(node),
  }).visit(parsed.program);
  let best: CommentLiveDuplicate | null = null;
  for (const fn of functions) {
    if (fn.start <= candidate.start && fn.end >= candidate.end) continue;
    const body = owner.source.slice(fn.start, fn.end);
    const shared = names.filter((name) =>
      new RegExp(`\\b${name.replace(/\$/g, "\\$")}\\b`).test(body)
    );
    if (shared.length >= 2 && (!best || shared.length > best.sharedIdentifiers.length)) {
      best = {
        functionName: functionName(parsed.program, fn) ?? null,
        sharedIdentifiers: shared.slice(0, 12),
      };
    }
  }
  return best;
}

export function buildCommentedOutImplementationEvidence(
  candidate: Candidate,
  projectFiles: ProjectFile[],
): CommentedOutImplementationEvidence | undefined {
  if (candidate.kind !== "comment") return undefined;
  const owner = projectFiles.find((file) => file.filePath === candidate.filePath);
  if (!owner) return undefined;

  const block = commentBlock(owner.source, candidate);
  if (!block.isFirst) return undefined;

  const stripped = stripMarkers(block.text);
  if (stripped.trim() === "") return undefined;
  const strippedLines = stripped.split("\n");

  let program = tryParse(`${owner.filePath}.commented.ts`, stripped);
  let needsFunctionWrap = false;
  if (!program) {
    program = tryParse(
      `${owner.filePath}.commented.ts`,
      `function __jev_probe() {\n${stripped}\n}`,
    );
    needsFunctionWrap = true;
  }
  if (!program) return undefined;

  const kinds = statementKinds(program);
  if (kinds.length === 0) return undefined;

  const keywords = [...new Set(stripped.match(new RegExp(KEYWORD_PATTERN, "g")) ?? [])].slice(0, 12);
  const semicolonLines = strippedLines.filter((line) => line.includes(";")).length;
  const openBraces = (stripped.match(/\{/g) ?? []).length;
  const closeBraces = (stripped.match(/\}/g) ?? []).length;
  const balancedBraces = openBraces > 0 && openBraces === closeBraces;
  const hasCall = hasCallExpression(program);

  if (
    keywords.length === 0
    && semicolonLines === 0
    && !balancedBraces
    && !hasCall
  ) return undefined;

  const names = identifiers(stripped);
  const repo = repoTextExcluding(block, owner, projectFiles);
  const unresolved = names
    .filter((name) => !new RegExp(`\\b${name.replace(/\$/g, "\\$")}\\b`).test(repo))
    .slice(0, 20);

  const proseLineCount = strippedLines.filter((line) => !CODE_PUNCTUATION.test(line)).length;

  return {
    comment: {
      filePath: candidate.filePath,
      source: candidate.source,
      startLine: candidate.startLine,
      lineCount: candidate.source.split("\n").length,
    },
    stripped: {
      text: stripped.slice(0, 4000),
      lineCount: strippedLines.length,
      proseLineCount,
    },
    codeSignals: {
      parseable: true,
      needsFunctionWrap,
      statementKinds: kinds.slice(0, 12),
      statementCount: kinds.length,
      balancedBraces,
      semicolonLines,
      keywords,
      hasCall,
    },
    staleness: {
      identifiers: names,
      resolvedCount: names.length - unresolved.length,
      unresolved,
    },
    liveDuplicate: liveDuplicate(owner, candidate, names),
  };
}
