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

export type DispatchArm = {
  kind: "switch-case" | "if-branch";
  test: string;
  bodyLength: number;
  constructsOrReturns: boolean;
  line: number;
};

export type TypeCodeDispatch = {
  discriminant: string;
  baseExpression: string;
  arms: DispatchArm[];
};

export type TypeCodeHandler = {
  filePath: string;
  functionName: string;
  discriminant: string;
  armCount: number;
};

export type TypeCodeDispatchEvidence = {
  function: {
    name: string;
    exported: boolean;
    filePath: string;
    source: string;
  };
  dispatch: TypeCodeDispatch;
  declaredUnionType: string | null;
  otherHandlers: TypeCodeHandler[];
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
  const match = /([\w$]+(?:\.[ \w$]+|\[['"][^'"]+['"]\]){1,3})/.exec(discriminant.trim());
  return match?.[1]?.replace(/\s+/g, "");
}

function isLiteralTest(source: string): boolean {
  const trimmed = source.trim();
  return /^["'`][\s\S]*["'`]$/.test(trimmed) || /^-?\d+(?:\.\d+)?$/.test(trimmed);
}

function armConstructsOrReturns(source: string, bodyStart: number, bodyEnd: number): boolean {
  const body = source.slice(bodyStart, bodyEnd);
  return /\breturn\b/.test(body) || /\bnew\s+[A-Z]/.test(body);
}

function collectDispatches(
  program: Program,
  fn: FunctionNode,
  source: string,
  candidate: Candidate,
): TypeCodeDispatch[] {
  const dispatches: TypeCodeDispatch[] = [];
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
      const arms: DispatchArm[] = [];
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
        arms.push({
          kind: "switch-case",
          test,
          bodyLength: caseNode.consequent.length,
          constructsOrReturns: armConstructsOrReturns(source, bodyStart ?? 0, bodyEnd ?? 0),
          line: lineAt(source, caseNode.start),
        });
      }
      if (arms.length >= 2) {
        dispatches.push({ discriminant, baseExpression: base, arms });
      }
    },
    IfStatement(node) {
      if (!own(node.start, node.end)) return;
      const comparisons: { base: string; test: string; line: number; bodyStart: number; bodyEnd: number }[] = [];
      let current: IfStatement | undefined = node;
      while (current) {
        if (!own(current.start, current.end)) break;
        const testSource = source.slice(current.test.start, current.test.end);
        const forward = /([\w$][\w$.[\]'"]*?)\s*===?\s*(["'`][^"'`]*["'`]|-?\d+(?:\.\d+)?)/.exec(testSource);
        const reversed = /(["'`][^"'`]*["'`]|-?\d+(?:\.\d+)?)\s*===?\s*([\w$][\w$.[\]'"]*)/.exec(testSource);
        const baseSource = forward?.[1] ?? reversed?.[2];
        if (!baseSource) break;
        const base = baseOfDiscriminant(baseSource);
        if (!base) break;
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
          current = undefined;
        }
      }
      if (comparisons.length >= 2) {
        const firstBase = comparisons[0]?.base;
        if (!firstBase || !comparisons.every(({ base }) => base === firstBase)) return;
        dispatches.push({
          discriminant: firstBase,
          baseExpression: firstBase,
          arms: comparisons.map(({ test, line, bodyStart, bodyEnd }) => ({
            kind: "if-branch" as const,
            test,
            bodyLength: 1,
            constructsOrReturns: armConstructsOrReturns(source, bodyStart, bodyEnd),
            line,
          })),
        });
      }
    },
  }).visit(program);
  return dispatches;
}

function declaredUnion(source: string, armTests: string[]): string | null {
  const aliasPattern = /type\s+(\w+)\s*=\s*([^;]+);/g;
  let match = aliasPattern.exec(source);
  while (match) {
    const body = match[2] ?? "";
    if (body.includes("|") && armTests.some((test) => body.includes(test.replace(/["'`]/g, "")))) {
      return `${match[1]} =${body}`.slice(0, 500);
    }
    match = aliasPattern.exec(source);
  }
  return null;
}

function otherHandlersOf(base: string, ownerPath: string, projectFiles: ProjectFile[]): TypeCodeHandler[] {
  const handlers: TypeCodeHandler[] = [];
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
      handlers.push({ filePath: file.filePath, functionName: name, discriminant: base, armCount });
      if (handlers.length >= 12) return handlers;
    }
  }
  return handlers;
}

export function buildTypeCodeDispatchEvidence(
  candidate: Candidate,
  projectFiles: ProjectFile[],
): TypeCodeDispatchEvidence | undefined {
  if (candidate.kind !== "function") return undefined;
  const owner = projectFiles.find((file) => file.filePath === candidate.filePath);
  if (!owner) return undefined;
  const parsed = parseCached(owner.filePath, owner.source);
  if (parsed.errors.some((error) => error.severity === "Error")) return undefined;
  const fn = findDirectFunction(parsed.program, candidate);
  if (!fn) return undefined;
  const name = functionName(parsed.program, fn);
  if (!name) return undefined;

  const dispatches = collectDispatches(parsed.program, fn, owner.source, candidate);
  if (dispatches.length === 0) return undefined;
  const dispatch = [...dispatches].sort((left, right) => right.arms.length - left.arms.length)[0];
  if (!dispatch) return undefined;

  return {
    function: {
      name,
      exported: isFunctionExported(parsed.program, fn, name),
      filePath: owner.filePath,
      source: candidate.source,
    },
    dispatch,
    declaredUnionType: declaredUnion(owner.source, dispatch.arms.map(({ test }) => test)),
    otherHandlers: otherHandlersOf(dispatch.baseExpression, owner.filePath, projectFiles),
    callers: findFunctionCallers(owner.filePath, name, projectFiles),
  };
}
