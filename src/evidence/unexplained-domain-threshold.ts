import { Visitor } from "oxc-parser";
import { parseCached } from "./parse-cache.js";
import type { Candidate, ProjectFile } from "../types.js";
import {
  findDirectFunction,
  findFunctionCallers,
  functionName,
  isFunctionExported,
  nestedFunctionRanges,
} from "./repository.js";
import type { FunctionCaller } from "./repository.js";

export type DomainThreshold = {
  expression: string;
  line: number;
  kind: "comparison" | "equality" | "index" | "slice";
  value: number;
  otherSide: string;
  otherIsNamedConstant: boolean;
  selfEvident: boolean;
  hasNearbyComment: boolean;
  typeConstrainsValue: boolean;
};

export type UnexplainedDomainThresholdEvidence = {
  function: {
    name: string;
    exported: boolean;
    filePath: string;
    source: string;
  };
  thresholds: DomainThreshold[];
  siblingNamedConstants: string[];
  reusedElsewhere: { value: number; comparedAgainst: string[] }[];
  callers: FunctionCaller[];
};

const MAX_THRESHOLDS = 10;
const MAX_EXCERPT_CHARS = 240;

function lineAt(source: string, offset: number): number {
  let line = 1;
  for (let index = 0; index < offset; index += 1) {
    if (source[index] === "\n") line += 1;
  }
  return line;
}

function isNamedConstant(text: string): boolean {
  return /^[A-Z][A-Z0-9_]*(\.[A-Z0-9_]+)*$/.test(text.trim());
}

function commentLines(source: string): Set<number> {
  const lines = new Set<number>();
  source.split("\n").forEach((text, index) => {
    if (/^\s*(\/\/|#|\*)/.test(text)) lines.add(index + 1);
  });
  return lines;
}

function typeConstrains(source: string, identifier: string): boolean {
  const pattern = new RegExp(`${identifier}\\s*:\\s*([^,)=;\\{\\}]+)`);
  const match = pattern.exec(source);
  if (!match?.[1]) return false;
  const annotation = match[1];
  return annotation.includes("|") || annotation.includes("enum ") || /Literal/.test(annotation);
}

function numericValue(raw: string | null): number | undefined {
  if (!raw || !/^[0-9]/.test(raw)) return undefined;
  const value = Number(raw);
  return Number.isFinite(value) ? value : undefined;
}

function comparisonKind(operator: string): "comparison" | "equality" | undefined {
  if (operator === ">" || operator === "<" || operator === ">=" || operator === "<=") return "comparison";
  if (operator === "===" || operator === "!==" || operator === "==" || operator === "!=") return "equality";
  return undefined;
}

export function buildUnexplainedDomainThresholdEvidence(
  candidate: Candidate,
  projectFiles: ProjectFile[],
): UnexplainedDomainThresholdEvidence | undefined {
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
  const comments = commentLines(owner.source);
  const thresholds: DomainThreshold[] = [];
  const push = (entry: Omit<DomainThreshold, "hasNearbyComment" | "typeConstrainsValue">): void => {
    if (thresholds.length >= MAX_THRESHOLDS) return;
    const hasNearbyComment = comments.has(entry.line) || comments.has(entry.line - 1);
    thresholds.push({
      ...entry,
      hasNearbyComment,
      typeConstrainsValue: /^[A-Za-z_$][\w$]*$/.test(entry.otherSide)
        ? typeConstrains(candidate.source, entry.otherSide)
        : false,
    });
  };

  new Visitor({
    BinaryExpression(node) {
      if (!direct(node)) return;
      const kind = comparisonKind(node.operator);
      if (!kind) return;
      const leftValue = node.left.type === "Literal" ? numericValue(node.left.raw) : undefined;
      const rightValue = node.right.type === "Literal" ? numericValue(node.right.raw) : undefined;
      const value = leftValue ?? rightValue;
      if (value === undefined) return;
      const other = owner.source.slice(
        leftValue !== undefined ? node.right.start : node.left.start,
        leftValue !== undefined ? node.right.end : node.left.end,
      );
      // A named constant on the other side is the remedy, not the smell.
      if (isNamedConstant(other)) return;
      push({
        expression: owner.source.slice(node.start, node.end).slice(0, MAX_EXCERPT_CHARS),
        line: lineAt(owner.source, node.start),
        kind,
        value,
        otherSide: other.slice(0, 120),
        otherIsNamedConstant: false,
        selfEvident: value === 0 || value === 1,
      });
    },
    MemberExpression(node) {
      if (!direct(node) || !node.computed) return;
      if (node.property.type !== "Literal") return;
      const value = numericValue(node.property.raw);
      if (value === undefined) return;
      push({
        expression: owner.source.slice(node.start, node.end).slice(0, MAX_EXCERPT_CHARS),
        line: lineAt(owner.source, node.start),
        kind: "index",
        value,
        otherSide: owner.source.slice(node.object.start, node.object.end).slice(0, 120),
        otherIsNamedConstant: false,
        selfEvident: value === 0 || value === 1,
      });
    },
    CallExpression(node) {
      if (!direct(node)) return;
      const callee = owner.source.slice(node.callee.start, node.callee.end);
      if (!/\.(slice|splice|substring|substr|at|charAt)$/.test(callee)) return;
      for (const argument of node.arguments) {
        if (argument.type !== "Literal") continue;
        const value = numericValue(argument.raw ?? null);
        if (value === undefined) continue;
        push({
          expression: owner.source.slice(node.start, node.end).slice(0, MAX_EXCERPT_CHARS),
          line: lineAt(owner.source, node.start),
          kind: "slice",
          value,
          otherSide: callee.slice(0, 120),
          otherIsNamedConstant: false,
          selfEvident: value === 0 || value === 1,
        });
      }
    },
  }).visit(parsed.program);

  if (thresholds.length === 0) return undefined;

  const siblingNamedConstants: string[] = [];
  new Visitor({
    VariableDeclarator(node) {
      if (node.id.type !== "Identifier" || !node.init) return;
      if (!/^[A-Z][A-Z0-9_]{1,}$/.test(node.id.name)) return;
      if (node.init.type !== "Literal" || numericValue(node.init.raw) === undefined) return;
      if (siblingNamedConstants.length < 8) siblingNamedConstants.push(node.id.name);
    },
  }).visit(parsed.program);

  const reusedElsewhere: { value: number; comparedAgainst: string[] }[] = [];
  for (const threshold of thresholds) {
    if (reusedElsewhere.length >= 5) break;
    if (reusedElsewhere.some(({ value }) => value === threshold.value)) continue;
    const compared = new Set<string>();
    const pattern = new RegExp(`(===|!==|==|!=|>=|<=|>|<)\\s*${threshold.value}\\b|\\b${threshold.value}\\s*(===|!==|==|!=|>=|<=|>|<)`);
    for (const file of projectFiles) {
      if (compared.size >= 4) break;
      if (file.filePath === candidate.filePath) continue;
      if (!pattern.test(file.source)) continue;
      const identifiers = file.source.match(new RegExp(`([A-Za-z_$][\\w$]*)\\s*(?:===|!==|==|!=|>=|<=|>|<)\\s*${threshold.value}`, "g"));
      for (const hit of identifiers ?? []) compared.add(hit.slice(0, 60));
    }
    if (compared.size > 0) {
      reusedElsewhere.push({ value: threshold.value, comparedAgainst: [...compared].slice(0, 4) });
    }
  }

  return {
    function: {
      name,
      exported: isFunctionExported(parsed.program, fn, name),
      filePath: owner.filePath,
      source: candidate.source,
    },
    thresholds,
    siblingNamedConstants,
    reusedElsewhere,
    callers: findFunctionCallers(owner.filePath, name, projectFiles),
  };
}
