import { Visitor } from "oxc-parser";
import { parseCached } from "./parse-cache.js";
import type { Candidate, ProjectFile } from "../types.js";
import type { IfStatement, Program } from "oxc-parser";
import {
  findDirectFunction,
  findFunctionCallers,
  functionName,
  isFunctionExported,
  nestedFunctionRanges,
} from "./repository.js";
import type { FunctionCaller, FunctionNode } from "./repository.js";

export type TableArm = {
  kind: "switch-case" | "if-branch" | "else";
  test: string;
  line: number;
};

export type TableMapping = {
  discriminant: string;
  baseExpression: string;
  arms: TableArm[];
};

export type TableConditionalEvidence = {
  function: {
    name: string;
    exported: boolean;
    filePath: string;
    source: string;
  };
  mapping: TableMapping;
  existingLookup: {
    found: boolean;
    snippet: string | null;
  };
  otherMappers: {
    filePath: string;
    functionName: string;
    discriminant: string;
    armCount: number;
  }[];
  callers: FunctionCaller[];
};

function lineAt(source: string, offset: number): number {
  let line = 1;
  for (let index = 0; index < offset; index += 1) {
    if (source[index] === "\n") line += 1;
  }
  return line;
}

function baseOfDiscriminant(discriminant: string): string | undefined {
  const match = /([\w$]+(?:\.[ \w$]+|\[['"][^'"]+['"]\]){0,3})/.exec(discriminant.trim());
  return match?.[1]?.replace(/\s+/g, "");
}

function isLiteralTest(source: string): boolean {
  const trimmed = source.trim();
  return /^["'`][\s\S]*["'`]$/.test(trimmed) || /^-?\d+(?:\.\d+)?$/.test(trimmed);
}

function literalInner(test: string): string {
  return test.trim().replace(/^["'`]|["'`]$/g, "");
}

function armHasBehavior(source: string, start: number, end: number): boolean {
  const wrapped = `function __arm() {${source.slice(start, end)}}`;
  const parsed = parseCached("arm.ts", wrapped);
  if (parsed.errors.some((error) => error.severity === "Error")) return true;
  let behavior = false;
  new Visitor({
    CallExpression() {
      behavior = true;
    },
    NewExpression() {
      behavior = true;
    },
    IfStatement() {
      behavior = true;
    },
    SwitchStatement() {
      behavior = true;
    },
    ForStatement() {
      behavior = true;
    },
    ForInStatement() {
      behavior = true;
    },
    ForOfStatement() {
      behavior = true;
    },
    WhileStatement() {
      behavior = true;
    },
    DoWhileStatement() {
      behavior = true;
    },
    TryStatement() {
      behavior = true;
    },
    ThrowStatement() {
      behavior = true;
    },
    UpdateExpression() {
      behavior = true;
    },
    AssignmentExpression(node) {
      if (node.left.type !== "Identifier") behavior = true;
    },
    AwaitExpression() {
      behavior = true;
    },
    YieldExpression() {
      behavior = true;
    },
  }).visit(parsed.program);
  return behavior;
}

function collectMappings(
  program: Program,
  fn: FunctionNode,
  source: string,
  candidate: Candidate,
): TableMapping[] {
  const mappings: TableMapping[] = [];
  const nested = nestedFunctionRanges(program, candidate);
  const own = (start: number, end: number): boolean => {
    if (start < fn.start || end > fn.end) return false;
    return !nested.some((range) => range.start <= start && range.end >= end);
  };

  new Visitor({
    SwitchStatement(node) {
      if (!own(node.start, node.end)) return;
      const discriminant = source.slice(node.discriminant.start, node.discriminant.end);
      const base = baseOfDiscriminant(discriminant);
      if (!base) return;
      const arms: TableArm[] = [];
      for (const caseNode of node.cases) {
        if (!caseNode.test) continue;
        const test = source.slice(caseNode.test.start, caseNode.test.end);
        if (!isLiteralTest(test)) continue;
        const bodyStart = caseNode.consequent.length > 0
          ? caseNode.consequent[0]?.start ?? caseNode.test.end
          : caseNode.test.end;
        const bodyEnd = caseNode.consequent.length > 0
          ? caseNode.consequent[caseNode.consequent.length - 1]?.end ?? caseNode.test.end
          : caseNode.test.end;
        if (armHasBehavior(source, bodyStart ?? 0, bodyEnd ?? 0)) return;
        arms.push({ kind: "switch-case", test, line: lineAt(source, caseNode.start) });
      }
      if (arms.length >= 3) {
        mappings.push({ discriminant, baseExpression: base, arms });
      }
    },
    IfStatement(node) {
      if (!own(node.start, node.end)) return;
      const comparisons: { base: string; test: string; line: number; bodyStart: number; bodyEnd: number }[] = [];
      let current: IfStatement | undefined = node;
      let trailingElse: { start: number; end: number } | null = null;
      while (current) {
        if (!own(current.start, current.end)) break;
        const testSource = source.slice(current.test.start, current.test.end);
        const forward = /([\w$][\w$.[\]'"]*?)\s*===?\s*(["'`][^"'`]*["'`]|-?\d+(?:\.\d+)?)/.exec(testSource);
        const reversed = /(["'`][^"'`]*["'`]|-?\d+(?:\.\d+)?)\s*===?\s*([\w$][\w$.[\]'"]*)/.exec(testSource);
        const baseSource = forward?.[1] ?? reversed?.[2];
        if (!baseSource) break;
        const base = baseOfDiscriminant(baseSource);
        if (!base) break;
        if (armHasBehavior(source, current.consequent.start, current.consequent.end)) return;
        comparisons.push({
          base,
          test: testSource,
          line: lineAt(source, current.start),
          bodyStart: current.consequent.start,
          bodyEnd: current.consequent.end,
        });
        const alternate: IfStatement["alternate"] = current.alternate;
        if (alternate?.type === "IfStatement") {
          current = alternate;
        } else {
          if (alternate) trailingElse = { start: alternate.start, end: alternate.end };
          current = undefined;
        }
      }
      if (comparisons.length === 0) return;
      const firstBase = comparisons[0]?.base;
      if (!firstBase || !comparisons.every(({ base }) => base === firstBase)) return;
      const arms: TableArm[] = comparisons.map(({ test, line }) => ({
        kind: "if-branch" as const,
        test,
        line,
      }));
      if (trailingElse) {
        if (armHasBehavior(source, trailingElse.start, trailingElse.end)) return;
        arms.push({ kind: "else" as const, test: "else", line: lineAt(source, trailingElse.start) });
      }
      if (arms.length >= 3) {
        mappings.push({ discriminant: firstBase, baseExpression: firstBase, arms });
      }
    },
  }).visit(program);
  return mappings;
}

export type ExistingLookup = {
  found: boolean;
  snippet: string | null;
};

function existingLookupInModule(
  source: string,
  fnStart: number,
  fnEnd: number,
  armTests: string[],
): ExistingLookup {
  const outside = source.slice(0, fnStart) + source.slice(fnEnd);
  const inners = armTests.map(literalInner).filter((inner) => inner.length > 0);
  let hits = 0;
  let snippet: string | null = null;
  for (const inner of inners) {
    const escaped = inner.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    const pattern = new RegExp(`["'\`]${escaped}["'\`]\\s*:`);
    const match = pattern.exec(outside);
    if (match) {
      hits += 1;
      if (!snippet) {
        const lineStart = outside.lastIndexOf("\n", match.index) + 1;
        snippet = outside.slice(lineStart, match.index + match[0].length + 40).trim().slice(0, 200);
      }
    }
  }
  if (hits >= 2) return { found: true, snippet };
  if (/Record\s*</.test(outside) || /new\s+Map\s*\(/.test(outside)) {
    return { found: true, snippet: null };
  }
  return { found: false, snippet: null };
}

function otherMappersOf(
  base: string,
  ownerPath: string,
  projectFiles: ProjectFile[],
): TableConditionalEvidence["otherMappers"] {
  const mappers: TableConditionalEvidence["otherMappers"] = [];
  const escaped = base.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const pattern = new RegExp(`switch\\s*\\(${escaped}\\)|${escaped}\\s*===?`);
  for (const file of projectFiles) {
    if (file.filePath === ownerPath) continue;
    if (!pattern.test(file.source)) continue;
    const parsed = parseCached(file.filePath, file.source);
    if (parsed.errors.some((error) => error.severity === "Error")) continue;
    const functions: FunctionNode[] = [];
    new Visitor({
      ArrowFunctionExpression: (node) => {
        functions.push(node);
      },
      FunctionDeclaration: (node) => {
        functions.push(node);
      },
      FunctionExpression: (node) => {
        functions.push(node);
      },
    }).visit(parsed.program);
    for (const fn of functions) {
      const body = file.source.slice(fn.start, fn.end);
      if (!pattern.test(body)) continue;
      const name = functionName(parsed.program, fn);
      if (!name) continue;
      const armCount = (body.match(new RegExp(escaped, "g")) ?? []).length;
      mappers.push({ filePath: file.filePath, functionName: name, discriminant: base, armCount });
      if (mappers.length >= 12) return mappers;
    }
  }
  return mappers;
}

export function buildTableConditionalEvidence(
  candidate: Candidate,
  projectFiles: ProjectFile[],
): TableConditionalEvidence | undefined {
  if (candidate.kind !== "function") return undefined;
  const owner = projectFiles.find((file) => file.filePath === candidate.filePath);
  if (!owner) return undefined;
  const parsed = parseCached(owner.filePath, owner.source);
  if (parsed.errors.some((error) => error.severity === "Error")) return undefined;
  const fn = findDirectFunction(parsed.program, candidate);
  if (!fn) return undefined;
  const name = functionName(parsed.program, fn);
  if (!name) return undefined;

  const mappings = collectMappings(parsed.program, fn, owner.source, candidate);
  if (mappings.length === 0) return undefined;
  const mapping = [...mappings].sort((left, right) => right.arms.length - left.arms.length)[0];
  if (!mapping) return undefined;

  return {
    function: {
      name,
      exported: isFunctionExported(parsed.program, fn, name),
      filePath: owner.filePath,
      source: candidate.source,
    },
    mapping,
    existingLookup: existingLookupInModule(
      owner.source,
      fn.start,
      fn.end,
      mapping.arms.map(({ test }) => test),
    ),
    otherMappers: otherMappersOf(mapping.baseExpression, owner.filePath, projectFiles),
    callers: findFunctionCallers(owner.filePath, name, projectFiles),
  };
}
