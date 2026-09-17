import { parseSync, Visitor } from "oxc-parser";
import type { CallExpression, Expression, Program } from "oxc-parser";
import type { Candidate, ProjectFile } from "../types.js";
import {
  findDirectFunction,
  findFunctionCallers,
  functionName,
  isFunctionExported,
  moduleImports,
  resolveModule,
} from "./repository.js";
import type { FunctionCaller } from "./repository.js";

type SourceRange = {
  start: number;
  end: number;
};

type IoOperation = {
  expression: string;
  awaited: boolean;
  certainty: "confirmed" | "possible";
  reason: string;
  importedFrom: string | null;
  targetModule: { filePath: string; source: string } | null;
};

export type HiddenIoEvidence = {
  function: {
    name: string;
    async: boolean;
    exported: boolean;
    filePath: string;
    source: string;
    moduleSource: string;
  };
  ioOperations: IoOperation[];
  callers: FunctionCaller[];
};

type Boundary = {
  certainty: "confirmed" | "possible";
  reason: string;
};

const IO_MODULES = new Set([
  "node:child_process",
  "node:dgram",
  "node:dns",
  "node:fs",
  "node:fs/promises",
  "node:http",
  "node:https",
  "node:net",
  "node:tls",
  "@aws-sdk/client-dynamodb",
  "@aws-sdk/client-s3",
  "@google-cloud/storage",
  "axios",
  "better-sqlite3",
  "got",
  "ioredis",
  "mongodb",
  "mysql2",
  "pg",
  "redis",
  "undici",
]);

function nestedFunctionRanges(candidate: Candidate, program: Program): SourceRange[] {
  const ranges: SourceRange[] = [];
  const add = (node: SourceRange): void => {
    if (node.start > candidate.start && node.end < candidate.end) ranges.push(node);
  };
  new Visitor({
    ArrowFunctionExpression: add,
    FunctionDeclaration: add,
    FunctionExpression: add,
  }).visit(program);
  return ranges;
}

function isDirect(node: SourceRange, candidate: Candidate, nested: SourceRange[]): boolean {
  return node.start >= candidate.start
    && node.end <= candidate.end
    && !nested.some((range) => range.start <= node.start && range.end >= node.end);
}

function rootIdentifier(expression: Expression): string | undefined {
  if (expression.type === "Identifier") return expression.name;
  if (expression.type === "MemberExpression") {
    return expression.object.type === "Super" ? undefined : rootIdentifier(expression.object);
  }
  if (expression.type === "ChainExpression") return rootIdentifier(expression.expression);
  if (
    expression.type === "TSAsExpression"
    || expression.type === "TSNonNullExpression"
    || expression.type === "TSSatisfiesExpression"
    || expression.type === "TSTypeAssertion"
  ) return rootIdentifier(expression.expression);
  return undefined;
}

function directAwaitedCall(expression: Expression): CallExpression | undefined {
  if (expression.type === "CallExpression") return expression;
  if (expression.type === "ChainExpression" && expression.expression.type === "CallExpression") {
    return expression.expression;
  }
  return undefined;
}

function declarationRange(program: Program, name: string): SourceRange | undefined {
  let result: SourceRange | undefined;
  new Visitor({
    FunctionDeclaration(node) {
      if (!result && node.id?.name === name) result = node;
    },
    VariableDeclarator(node) {
      if (
        !result
        && node.id.type === "Identifier"
        && node.id.name === name
        && node.init
        && (node.init.type === "ArrowFunctionExpression" || node.init.type === "FunctionExpression")
      ) result = node.init;
    },
  }).visit(program);
  return result;
}

function projectBoundary(target: ProjectFile, importedName: string): Boundary | undefined {
  const parsed = parseSync(target.filePath, target.source, { range: true });
  if (parsed.errors.some((error) => error.severity === "Error")) return undefined;
  const range = importedName === "default"
    ? { start: parsed.program.start, end: parsed.program.end }
    : declarationRange(parsed.program, importedName);
  if (!range) return undefined;
  const imports = moduleImports(parsed.program);
  let boundary: Boundary | undefined;
  new Visitor({
    CallExpression(call) {
      if (boundary || call.start < range.start || call.end > range.end) return;
      const root = rootIdentifier(call.callee);
      const imported = root ? imports.find(({ local }) => local === root) : undefined;
      if (root === "fetch" && !imported) {
        boundary = { certainty: "confirmed", reason: "project target calls global fetch" };
      } else if (imported && IO_MODULES.has(imported.source)) {
        boundary = {
          certainty: "confirmed",
          reason: `project target calls I/O module ${imported.source}`,
        };
      }
    },
  }).visit(parsed.program);
  return boundary;
}

export function buildHiddenIoEvidence(
  candidate: Candidate,
  projectFiles: ProjectFile[],
): HiddenIoEvidence | undefined {
  if (candidate.kind !== "function") return undefined;
  const owner = projectFiles.find((file) => file.filePath === candidate.filePath);
  if (!owner) return undefined;
  const parsed = parseSync(owner.filePath, owner.source, { range: true });
  if (parsed.errors.some((error) => error.severity === "Error")) return undefined;
  const fn = findDirectFunction(parsed.program, candidate);
  if (!fn) return undefined;
  const name = functionName(parsed.program, fn);
  if (!name) return undefined;

  const nested = nestedFunctionRanges(candidate, parsed.program);
  const imports = moduleImports(parsed.program);
  const awaitedCalls = new Set<number>();
  const operations: Array<IoOperation & SourceRange> = [];

  new Visitor({
    AwaitExpression(node) {
      if (!isDirect(node, candidate, nested)) return;
      const call = directAwaitedCall(node.argument);
      if (call) awaitedCalls.add(call.start);
    },
  }).visit(parsed.program);

  new Visitor({
    CallExpression(call) {
      if (!isDirect(call, candidate, nested)) return;
      const root = rootIdentifier(call.callee);
      const imported = root ? imports.find(({ local }) => local === root) : undefined;
      const target = imported
        ? resolveModule(owner.filePath, imported.source, projectFiles)
        : undefined;
      let boundary: Boundary | undefined;
      if (root === "fetch" && !imported) {
        boundary = { certainty: "confirmed", reason: "calls global fetch" };
      } else if (imported && IO_MODULES.has(imported.source)) {
        boundary = { certainty: "confirmed", reason: `calls I/O module ${imported.source}` };
      } else if (imported && target) {
        boundary = projectBoundary(target, imported.imported)
          ?? (awaitedCalls.has(call.start)
            ? { certainty: "possible", reason: "awaited project call with no confirmed boundary" }
            : undefined);
      } else if (imported && awaitedCalls.has(call.start)) {
        boundary = { certainty: "possible", reason: "awaited external package call" };
      }
      if (!boundary) return;
      operations.push({
        expression: owner.source.slice(call.start, call.end),
        awaited: awaitedCalls.has(call.start),
        certainty: boundary.certainty,
        reason: boundary.reason,
        importedFrom: imported?.source ?? null,
        targetModule: target
          ? { filePath: target.filePath, source: target.source.slice(0, 12_000) }
          : null,
        start: call.start,
        end: call.end,
      });
    },
  }).visit(parsed.program);

  if (operations.length === 0) return undefined;
  operations.sort((left, right) => left.start - right.start);
  return {
    function: {
      name,
      async: fn.async,
      exported: isFunctionExported(parsed.program, fn, name),
      filePath: owner.filePath,
      source: candidate.source,
      moduleSource: owner.source.slice(0, 16_000),
    },
    ioOperations: operations.map(({
      expression,
      awaited,
      certainty,
      reason,
      importedFrom,
      targetModule,
    }) => ({ expression, awaited, certainty, reason, importedFrom, targetModule })),
    callers: findFunctionCallers(candidate.filePath, name, projectFiles),
  };
}
