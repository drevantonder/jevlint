import { Visitor } from "oxc-parser";
import { parseCached } from "./parse-cache.js";
import type { Candidate, ProjectFile } from "../types.js";
import {
  findDirectFunction,
  functionName,
  isFunctionExported,
  nestedFunctionRanges,
} from "./repository.js";

export type GuardedOperation = {
  call: string;
  callee: string;
  awaited: boolean;
  guarded: boolean;
  line: number;
};

export type OperationGroup = {
  kind: string;
  guarded: GuardedOperation[];
  unguarded: GuardedOperation[];
};

export type LopsidedErrorHandlingEvidence = {
  function: {
    name: string;
    exported: boolean;
    filePath: string;
    source: string;
  };
  groups: OperationGroup[];
  outerHandlerCoversBody: boolean;
};

function lineAt(source: string, offset: number): number {
  let line = 1;
  for (let index = 0; index < offset; index += 1) {
    if (source[index] === "\n") line += 1;
  }
  return line;
}

export function buildLopsidedErrorHandlingEvidence(
  candidate: Candidate,
  projectFiles: ProjectFile[],
): LopsidedErrorHandlingEvidence | undefined {
  if (candidate.kind !== "function") return undefined;
  const owner = projectFiles.find((file) => file.filePath === candidate.filePath);
  if (!owner) return undefined;
  const parsed = parseCached(owner.filePath, owner.source);
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

  const tryRanges: Array<{ start: number; end: number; statementCount: number }> = [];
  const awaitRanges: Array<{ start: number; end: number }> = [];
  const catchChained = new Set<string>();
  new Visitor({
    TryStatement(node) {
      if (!direct(node.start, node.end)) return;
      tryRanges.push({ start: node.start, end: node.end, statementCount: node.block.body.length });
    },
    AwaitExpression(node) {
      if (direct(node.start, node.end)) awaitRanges.push({ start: node.start, end: node.end });
    },
    CallExpression(node) {
      if (!direct(node.start, node.end)) return;
      if (node.callee.type !== "MemberExpression") return;
      if (node.callee.property.type !== "Identifier" || node.callee.property.name !== "catch") return;
      catchChained.add(owner.source.slice(node.callee.object.start, node.callee.object.end));
    },
  }).visit(parsed.program);

  const bodySpan = Math.max(1, fn.body.end - fn.body.start);
  const outerHandlerCoversBody = tryRanges.some(
    (range) => (range.end - range.start) / bodySpan >= 0.8,
  );
  if (outerHandlerCoversBody) return undefined;

  const operations: GuardedOperation[] = [];
  new Visitor({
    CallExpression(node) {
      if (!direct(node.start, node.end)) return;
      if (node.callee.type === "MemberExpression"
        && node.callee.property.type === "Identifier"
        && node.callee.property.name === "catch") return;
      const text = owner.source.slice(node.start, node.end);
      const callee = owner.source.slice(node.callee.start, node.callee.end);
      const awaited = awaitRanges.some((range) => range.start <= node.start && range.end >= node.end);
      const inTry = tryRanges.some((range) => range.start <= node.start && range.end >= node.end);
      operations.push({
        call: text,
        callee,
        awaited,
        guarded: inTry || catchChained.has(text),
        line: lineAt(owner.source, node.start),
      });
    },
  }).visit(parsed.program);

  if (operations.length === 0) return undefined;

  const byKind = new Map<string, GuardedOperation[]>();
  for (const operation of operations) {
    const root = operation.callee.includes(".")
      ? (operation.callee.split(".")[0] ?? operation.callee)
      : operation.callee;
    const key = `${operation.awaited ? "await:" : "call:"}${root}`;
    const existing = byKind.get(key) ?? [];
    existing.push(operation);
    byKind.set(key, existing);
  }

  const groups: OperationGroup[] = [];
  for (const [kind, items] of byKind) {
    const guarded = items.filter((item) => item.guarded);
    const unguarded = items.filter((item) => !item.guarded);
    if (items.length >= 2 && guarded.length > 0 && unguarded.length > 0) {
      groups.push({ kind, guarded, unguarded });
    }
  }
  if (groups.length === 0) return undefined;

  return {
    function: {
      name,
      exported: isFunctionExported(parsed.program, fn, name),
      filePath: candidate.filePath,
      source: candidate.source,
    },
    groups,
    outerHandlerCoversBody,
  };
}
