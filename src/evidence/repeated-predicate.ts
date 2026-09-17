import { parseSync, Visitor } from "oxc-parser";
import type { Candidate, ProjectFile } from "../types.js";
import {
  findDirectFunction,
  functionName,
  isFunctionExported,
  nestedFunctionRanges,
} from "./repository.js";

export type PredicateOccurrence = {
  test: string;
  line: number;
};

export type RepeatedPredicate = {
  predicate: string;
  occurrences: PredicateOccurrence[];
  boundToName: string | null;
  interveningAwait: boolean;
};

export type RepeatedPredicateEvidence = {
  function: {
    name: string;
    exported: boolean;
    filePath: string;
    source: string;
  };
  repetitions: RepeatedPredicate[];
};

function lineAt(source: string, offset: number): number {
  let line = 1;
  for (let index = 0; index < offset; index += 1) {
    if (source[index] === "\n") line += 1;
  }
  return line;
}

function identifiersOf(test: string): Set<string> {
  const names = new Set<string>();
  const wrapped = `function __pred() { return (${test}); }`;
  const parsed = parseSync("pred.ts", wrapped, { range: true });
  if (parsed.errors.some((error) => error.severity === "Error")) return names;
  new Visitor({
    Identifier(node) {
      names.add(node.name);
    },
  }).visit(parsed.program);
  return names;
}

function normalizePredicate(test: string): string {
  const names = [...identifiersOf(test)].sort();
  let normalized = test.replace(/\s+/g, " ").replace(/\(\s+/g, "(").replace(/\s+\)/g, ")").trim();
  for (const [index, name] of names.entries()) {
    normalized = normalized.replace(new RegExp(`\\b${name}\\b`, "g"), `$v${index}`);
  }
  return normalized;
}

export function buildRepeatedPredicateEvidence(
  candidate: Candidate,
  projectFiles: ProjectFile[],
): RepeatedPredicateEvidence | undefined {
  if (candidate.kind !== "function") return undefined;
  const owner = projectFiles.find((file) => file.filePath === candidate.filePath);
  if (!owner) return undefined;
  const parsed = parseSync(owner.filePath, owner.source, { range: true });
  if (parsed.errors.some((error) => error.severity === "Error")) return undefined;
  const fn = findDirectFunction(parsed.program, candidate);
  if (!fn || !fn.body) return undefined;
  const name = functionName(parsed.program, fn);
  if (!name) return undefined;
  const nested = nestedFunctionRanges(parsed.program, candidate);

  const direct = (start: number, end: number): boolean =>
    start >= candidate.start
    && end <= candidate.end
    && !nested.some((range) => range.start <= start && range.end >= end);

  const tests: Array<{ test: string; line: number; start: number; end: number }> = [];
  const record = (start: number, end: number, testStart: number, testEnd: number): void => {
    if (!direct(start, end)) return;
    tests.push({
      test: owner.source.slice(testStart, testEnd),
      line: lineAt(owner.source, start),
      start,
      end,
    });
  };

  new Visitor({
    IfStatement(node) {
      record(node.start, node.end, node.test.start, node.test.end);
    },
    ConditionalExpression(node) {
      record(node.start, node.end, node.test.start, node.test.end);
    },
    LogicalExpression(node) {
      if (node.operator !== "&&" && node.operator !== "||") return;
      record(node.start, node.end, node.left.start, node.left.end);
    },
    CallExpression(node) {
      const callee = owner.source.slice(node.callee.start, node.callee.end);
      if (!/(?:^|\.)assert/.test(callee)) return;
      if (node.arguments.length === 0) return;
      const first = node.arguments[0];
      if (!first) return;
      record(node.start, node.end, first.start, first.end);
    },
  }).visit(parsed.program);

  if (tests.length < 2) return undefined;

  const boundNames = new Map<string, string>();
  const boundIdentifiers = new Set<string>();
  new Visitor({
    VariableDeclarator(node) {
      if (!direct(node.start, node.end)) return;
      if (node.id.type !== "Identifier" || !node.init) return;
      boundNames.set(
        owner.source.slice(node.init.start, node.init.end),
        node.id.name,
      );
      boundIdentifiers.add(node.id.name);
    },
  }).visit(parsed.program);

  const awaitOffsets: number[] = [];
  new Visitor({
    AwaitExpression(node) {
      if (direct(node.start, node.end)) awaitOffsets.push(node.start);
    },
  }).visit(parsed.program);

  const assignedBetween = (identifiers: Set<string>, from: number, to: number): boolean => {
    let mutated = false;
    new Visitor({
      AssignmentExpression(node) {
        if (node.start < from || node.end > to) return;
        if (node.left.type === "Identifier" && identifiers.has(node.left.name)) mutated = true;
      },
      UpdateExpression(node) {
        if (node.start < from || node.end > to) return;
        if (node.argument.type === "Identifier" && identifiers.has(node.argument.name)) mutated = true;
      },
    }).visit(parsed.program);
    return mutated;
  };

  const byNormalized = new Map<string, typeof tests>();
  for (const test of tests) {
    const key = normalizePredicate(test.test);
    const existing = byNormalized.get(key) ?? [];
    existing.push(test);
    byNormalized.set(key, existing);
  }

  const repetitions: RepeatedPredicate[] = [];
  for (const occurrences of byNormalized.values()) {
    if (occurrences.length < 2) continue;
    const first = occurrences[0];
    const last = occurrences[occurrences.length - 1];
    if (!first || !last) continue;
    const identifiers = new Set<string>();
    for (const occurrence of occurrences) {
      for (const identifier of identifiersOf(occurrence.test)) identifiers.add(identifier);
    }
    if (assignedBetween(identifiers, first.start, last.end)) continue;
    const interveningAwait = awaitOffsets.some((offset) => offset > first.start && offset < last.end);
    const boundToName = boundNames.get(first.test)
      ?? occurrences.map((occurrence) => boundNames.get(occurrence.test)).find((bound) => bound !== undefined)
      ?? null;
    const reusesBindingOnly = boundToName !== null
      && occurrences.every((occurrence) => occurrence.test.trim() === boundToName);
    if (reusesBindingOnly) continue;
    const reusesBoundName = occurrences.every((occurrence) => {
      const trimmed = occurrence.test.trim();
      return /^[A-Za-z_$][\w$]*$/.test(trimmed) && boundIdentifiers.has(trimmed);
    });
    if (reusesBoundName) continue;
    repetitions.push({
      predicate: first.test,
      occurrences: occurrences.map(({ test, line }) => ({ test, line })),
      boundToName,
      interveningAwait,
    });
  }

  if (repetitions.length === 0) return undefined;

  return {
    function: {
      name,
      exported: isFunctionExported(parsed.program, fn, name),
      filePath: candidate.filePath,
      source: candidate.source,
    },
    repetitions,
  };
}
