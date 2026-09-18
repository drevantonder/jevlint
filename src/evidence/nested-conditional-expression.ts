import { Visitor } from "oxc-parser";
import { parseCached } from "./parse-cache.js";
import type { Candidate, ProjectFile, SourceFile } from "../types.js";
import {
  findDirectFunction,
  findFunctionCallers,
  functionName,
  isFunctionExported,
  nestedFunctionRanges,
} from "./repository.js";
import type { FunctionCaller } from "./repository.js";

export type ConditionalSite = {
  kind: "conditional" | "logical";
  line: number;
  depth: number;
  operands: number;
  position: "return" | "jsx" | "other";
  inChangedLines: boolean;
  snippet: string;
};

export type NestedConditionalExpressionEvidence = {
  function: {
    name: string;
    exported: boolean;
    filePath: string;
    source: string;
  };
  maxConditionalDepth: number;
  maxLogicalOperands: number;
  sites: ConditionalSite[];
  namedBooleans: string[];
  callers: FunctionCaller[];
};

function lineAt(source: string, offset: number): number {
  let line = 1;
  for (let index = 0; index < offset; index += 1) {
    if (source[index] === "\n") line += 1;
  }
  return line;
}

function inChangedLines(
  line: number,
  candidate: Candidate,
  changes: SourceFile[],
): boolean {
  const change = changes.find((file) => file.filePath === candidate.filePath);
  if (!change) return false;
  return change.changedLines.some((range) => line >= range.start && line <= range.end);
}

function countOperands(source: string, start: number, end: number): number {
  const text = source.slice(start, end);
  const operators = text.match(/&&|\|\||\?\?/g);
  return (operators?.length ?? 0) + 1;
}

const BOOLEAN_INIT_PATTERN = /===|!==|>=?|<=?|&&|\|\||!\s*\w/;

export function buildNestedConditionalExpressionEvidence(
  candidate: Candidate,
  projectFiles: ProjectFile[],
  changes: SourceFile[] = [],
): NestedConditionalExpressionEvidence | undefined {
  if (candidate.kind !== "function") return undefined;
  const owner = projectFiles.find((file) => file.filePath === candidate.filePath);
  if (!owner) return undefined;
  const parsed = parseCached(owner.filePath, owner.source);
  if (parsed.errors.some((error) => error.severity === "Error")) return undefined;
  const fn = findDirectFunction(parsed.program, candidate);
  if (!fn) return undefined;
  const name = functionName(parsed.program, fn);
  if (!name) return undefined;

  const nested = nestedFunctionRanges(parsed.program, candidate);
  const direct = (node: { start: number; end: number }): boolean =>
    node.start >= candidate.start
    && node.end <= candidate.end
    && !nested.some((range) => range.start <= node.start && range.end >= node.end);

  const returnRanges: { start: number; end: number }[] = [];
  const jsxRanges: { start: number; end: number }[] = [];
  new Visitor({
    ReturnStatement(node) {
      if (direct(node) && node.argument) returnRanges.push({ start: node.argument.start, end: node.argument.end });
    },
    JSXExpressionContainer(node) {
      if (direct(node)) jsxRanges.push({ start: node.start, end: node.end });
    },
    JSXElement(node) {
      if (direct(node)) jsxRanges.push({ start: node.start, end: node.end });
    },
    JSXFragment(node) {
      if (direct(node)) jsxRanges.push({ start: node.start, end: node.end });
    },
  }).visit(parsed.program);

  const positionOf = (start: number, end: number): ConditionalSite["position"] => {
    if (returnRanges.some((range) => range.start <= start && range.end >= end)) return "return";
    if (jsxRanges.some((range) => range.start <= start && range.end >= end)) return "jsx";
    return "other";
  };

  const sites: ConditionalSite[] = [];
  let maxConditionalDepth = 0;
  let maxLogicalOperands = 0;

  const conditionals: { start: number; end: number }[] = [];
  new Visitor({
    ConditionalExpression(node) {
      if (direct(node)) conditionals.push({ start: node.start, end: node.end });
    },
  }).visit(parsed.program);

  const depthOf = (start: number, end: number): number =>
    1 + conditionals.filter((outer) =>
      (outer.start < start || outer.end > end) && outer.start <= start && outer.end >= end
      && !(outer.start === start && outer.end === end)
    ).length;

  for (const node of conditionals) {
    const depth = depthOf(node.start, node.end);
    if (depth > maxConditionalDepth) maxConditionalDepth = depth;
    const line = lineAt(owner.source, node.start);
    sites.push({
      kind: "conditional",
      line,
      depth,
      operands: 3,
      position: positionOf(node.start, node.end),
      inChangedLines: inChangedLines(line, candidate, changes),
      snippet: owner.source.slice(node.start, node.end).slice(0, 300),
    });
  }

  const logicals: { start: number; end: number }[] = [];
  new Visitor({
    LogicalExpression(node) {
      if (!direct(node)) return;
      logicals.push({ start: node.start, end: node.end });
    },
  }).visit(parsed.program);

  const topLevelLogicals = logicals.filter((node) =>
    !logicals.some((outer) =>
      outer.start <= node.start && outer.end >= node.end
      && !(outer.start === node.start && outer.end === node.end)
    )
  );
  for (const node of topLevelLogicals) {
    const operands = countOperands(owner.source, node.start, node.end);
    if (operands > maxLogicalOperands) maxLogicalOperands = operands;
    const position = positionOf(node.start, node.end);
    if (position === "other") continue;
    const line = lineAt(owner.source, node.start);
    sites.push({
      kind: "logical",
      line,
      depth: 1,
      operands,
      position,
      inChangedLines: inChangedLines(line, candidate, changes),
      snippet: owner.source.slice(node.start, node.end).slice(0, 300),
    });
  }

  const relevant = sites.filter(({ position }) => position !== "other");
  const nestedConditional = conditionals.some((node) => depthOf(node.start, node.end) >= 2);
  const longChain = relevant.some(({ kind, operands }) => kind === "logical" && operands >= 3);
  const returnConditional = relevant.some(({ kind }) => kind === "conditional");
  if (!nestedConditional && !longChain && !returnConditional) return undefined;

  const namedBooleans: string[] = [];
  new Visitor({
    VariableDeclarator(node) {
      if (!direct(node) || node.id.type !== "Identifier" || !node.init) return;
      const initText = owner.source.slice(node.init.start, node.init.end);
      if (BOOLEAN_INIT_PATTERN.test(initText) && !namedBooleans.includes(node.id.name)) {
        namedBooleans.push(node.id.name);
      }
    },
  }).visit(parsed.program);

  sites.sort((left, right) => left.line - right.line);

  return {
    function: {
      name,
      exported: isFunctionExported(parsed.program, fn, name),
      filePath: candidate.filePath,
      source: candidate.source,
    },
    maxConditionalDepth,
    maxLogicalOperands,
    sites: sites.slice(0, 20),
    namedBooleans: namedBooleans.slice(0, 10),
    callers: findFunctionCallers(candidate.filePath, name, projectFiles),
  };
}
