import { Visitor } from "oxc-parser";
import { parseCached } from "./parse-cache.js";
import type { Expression, IfStatement, Program, ReturnStatement } from "oxc-parser";
import type { Candidate, ProjectFile } from "../types.js";
import { belongsDirectlyToFunction, containsNode, nestedFunctionRanges } from "./function-scope.js";
import {
  findDirectFunction,
  findFunctionCallersWithCoverage,
  functionName,
  isFunctionExported,
} from "./repository.js";

const MAX_QUIRKS = 5;
const MAX_CALLERS = 3;
const MAX_CALL_CHARS = 240;
const MAX_SOURCE_CHARS = 300;

export type CompatQuirk = {
  kind: "special-case" | "unusual-return";
  line: number;
  source: string;
  literal: string | null;
  exercisedByCallers: string[];
};

export type UnpinnedCompatQuirkEvidence = {
  function: {
    name: string;
    exported: boolean;
    filePath: string;
    source: string;
  };
  quirks: CompatQuirk[];
  callers: {
    total: number;
    files: string[];
    sampleCalls: string[];
  };
  pinning: {
    commentAbove: boolean;
    testReferences: string[];
  };
};

function lineAt(source: string, offset: number): number {
  let line = 1;
  for (let index = 0; index < offset && index < source.length; index += 1) {
    if (source[index] === "\n") line += 1;
  }
  return line;
}

function isLiteral(expression: Expression): boolean {
  return expression.type === "Literal"
    || (expression.type === "TemplateLiteral" && expression.expressions.length === 0);
}

function specialCaseLiteral(test: IfStatement["test"], source: string): string | undefined {
  const unwrapped = test.type === "ChainExpression" ? test.expression : test;
  if (unwrapped.type !== "BinaryExpression") return undefined;
  const comparison = unwrapped;
  if (
    comparison.operator !== "==="
    && comparison.operator !== "!=="
    && comparison.operator !== "=="
    && comparison.operator !== "!="
  ) return undefined;
  if (isLiteral(comparison.left)) return source.slice(comparison.left.start, comparison.left.end);
  if (isLiteral(comparison.right)) return source.slice(comparison.right.start, comparison.right.end);
  return undefined;
}

function returnSignature(node: ReturnStatement): string {
  if (!node.argument) return "bare";
  const argument = node.argument;
  if (argument.type === "Literal") return "literal";
  return argument.type;
}

function isTestPath(filePath: string): boolean {
  const lower = filePath.toLowerCase();
  return lower.includes("test") || lower.includes("spec") || lower.includes("__tests__");
}

export function buildUnpinnedCompatQuirkEvidence(
  candidate: Candidate,
  projectFiles: ProjectFile[],
): UnpinnedCompatQuirkEvidence | undefined {
  if (candidate.kind !== "function") return undefined;
  const owner = projectFiles.find((file) => file.filePath === candidate.filePath);
  if (!owner) return undefined;
  const parsed: { program: Program; errors: Array<{ severity: string }> } = parseCached(
    owner.filePath,
    owner.source);
  if (parsed.errors.some((error) => error.severity === "Error")) return undefined;
  const fn = findDirectFunction(parsed.program, candidate);
  if (!fn) return undefined;
  const name = functionName(parsed.program, fn);
  if (!name) return undefined;

  const nested = nestedFunctionRanges(parsed.program, fn);
  const inScope = (node: { start: number; end: number }): boolean =>
    containsNode(fn, node) && belongsDirectlyToFunction(node, nested);

  const quirks: CompatQuirk[] = [];
  const returns: ReturnStatement[] = [];

  new Visitor({
    IfStatement(node) {
      if (!inScope(node)) return;
      const literal = specialCaseLiteral(node.test, owner.source);
      if (literal === undefined) return;
      if (quirks.length >= MAX_QUIRKS) return;
      quirks.push({
        kind: "special-case",
        line: lineAt(owner.source, node.start),
        source: owner.source.slice(node.start, node.end).slice(0, MAX_SOURCE_CHARS),
        literal,
        exercisedByCallers: [],
      });
    },
    ReturnStatement(node) {
      if (inScope(node)) returns.push(node);
    },
  }).visit(parsed.program);

  if (returns.length >= 2) {
    const counts = new Map<string, number>();
    for (const node of returns) {
      const signature = returnSignature(node);
      counts.set(signature, (counts.get(signature) ?? 0) + 1);
    }
    for (const node of returns) {
      if (quirks.length >= MAX_QUIRKS) break;
      const signature = returnSignature(node);
      const count = counts.get(signature) ?? 0;
      if (count * 2 >= returns.length) continue;
      quirks.push({
        kind: "unusual-return",
        line: lineAt(owner.source, node.start),
        source: owner.source.slice(node.start, node.end).slice(0, MAX_SOURCE_CHARS),
        literal: null,
        exercisedByCallers: [],
      });
    }
  }

  if (quirks.length === 0) return undefined;

  const coverage = findFunctionCallersWithCoverage(candidate.filePath, name, projectFiles);
  if (coverage.total === 0) return undefined;

  const sampled = coverage.callers.slice(0, MAX_CALLERS);
  for (const quirk of quirks) {
    const literal = quirk.literal;
    if (!literal) continue;
    const needle = literal.replace(/^['"`]|['"`]$/g, "");
    quirk.exercisedByCallers = coverage.callers
      .filter(({ call, arguments: parameters }) =>
        call.includes(literal)
        || (needle.length > 0 && parameters.some((parameter) => parameter.includes(needle)))
      )
      .slice(0, MAX_CALLERS)
      .map(({ call }) => call.slice(0, MAX_CALL_CHARS));
  }

  const beforeFunction = owner.source.slice(Math.max(0, fn.start - 500), fn.start);
  const testReferences = projectFiles
    .filter((file) => file.filePath !== owner.filePath && isTestPath(file.filePath) && file.source.includes(name))
    .map((file) => file.filePath)
    .slice(0, MAX_CALLERS);

  return {
    function: {
      name,
      exported: isFunctionExported(parsed.program, fn, name),
      filePath: candidate.filePath,
      source: candidate.source,
    },
    quirks,
    callers: {
      total: coverage.total,
      files: [...new Set(coverage.callers.map(({ filePath }) => filePath))].slice(0, MAX_CALLERS),
      sampleCalls: sampled.map(({ call }) => call.slice(0, MAX_CALL_CHARS)),
    },
    pinning: {
      commentAbove: beforeFunction.includes("//") || beforeFunction.includes("/*"),
      testReferences,
    },
  };
}
