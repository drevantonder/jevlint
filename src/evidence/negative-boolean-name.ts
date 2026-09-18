import { Visitor } from "oxc-parser";
import { parseCached } from "./parse-cache.js";
import type { Expression } from "oxc-parser";
import type { Candidate, ProjectFile } from "../types.js";
import {
  findDirectFunction,
  findFunctionCallers,
  functionName,
  isFunctionExported,
  nestedFunctionRanges,
} from "./repository.js";
import type { FunctionCaller, FunctionNode } from "./repository.js";

export type NegativeBoolean = {
  name: string;
  kind: "parameter" | "local";
  pattern: string;
  source: string;
};

export type NegatedRead = {
  expression: string;
  line: number;
};

export type NegativeBooleanNameEvidence = {
  function: {
    name: string;
    exported: boolean;
    filePath: string;
    source: string;
  };
  booleans: NegativeBoolean[];
  negatedReads: NegatedRead[];
  callers: FunctionCaller[];
};

const NEGATIVE_PATTERNS: Array<{ pattern: RegExp; label: string }> = [
  { pattern: /Not[A-Z]/, label: "embedded Not" },
  { pattern: /^no[A-Z]/, label: "no- prefix" },
  { pattern: /^not[A-Z]/, label: "not- prefix" },
  { pattern: /^Without[A-Z]/, label: "without- prefix" },
  { pattern: /^Never[A-Z]/, label: "never- prefix" },
  { pattern: /^(disable|disabled|exclude|deny|non|un|dis)[A-Z]/, label: "negative prefix" },
  { pattern: /^(disabled|excluded|denied|invalid)$/, label: "bare negative adjective" },
  { pattern: /Disabled([A-Z]|$)/, label: "Disabled suffix" },
];

function negativeLabel(name: string): string | null {
  for (const { pattern, label } of NEGATIVE_PATTERNS) {
    if (pattern.test(name)) return label;
  }
  return null;
}

function isBooleanLiteral(node: Expression): boolean {
  return node.type === "Literal" && (node.value === true || node.value === false);
}

function isBooleanLike(annotation: string | null, init: Expression | null): boolean {
  if (annotation !== null) return /\bboolean\b/.test(annotation);
  if (init === null) return false;
  if (isBooleanLiteral(init)) return true;
  return init.type === "UnaryExpression"
    || init.type === "BinaryExpression"
    || init.type === "LogicalExpression";
}

function bindingName(parameter: FunctionNode["params"][number]): string | undefined {
  const value = parameter.type === "TSParameterProperty" ? parameter.parameter : parameter;
  if (value.type === "AssignmentPattern" && value.left.type === "Identifier") {
    return value.left.name;
  }
  if (value.type === "RestElement" && value.argument.type === "Identifier") {
    return value.argument.name;
  }
  if (value.type !== "Identifier") return undefined;
  return value.name;
}

export type ParamTypeInfo = {
  annotation: string | null;
  init: Expression | null;
};

function annotationOf(
  parameter: FunctionNode["params"][number],
  source: string,
): ParamTypeInfo {
  const value = parameter.type === "TSParameterProperty" ? parameter.parameter : parameter;
  if (value.type === "AssignmentPattern") {
    const identifier = value.left.type === "Identifier" ? value.left : null;
    return {
      annotation: identifier?.typeAnnotation
        ? source
          .slice(identifier.typeAnnotation.start, identifier.typeAnnotation.end)
          .replace(/^:\s*/, "")
        : null,
      init: value.right,
    };
  }
  if (value.type !== "Identifier") return { annotation: null, init: null };
  return {
    annotation: value.typeAnnotation
      ? source.slice(value.typeAnnotation.start, value.typeAnnotation.end).replace(/^:\s*/, "")
      : null,
    init: null,
  };
}

function lineAt(source: string, offset: number): number {
  let line = 1;
  for (let index = 0; index < offset; index += 1) {
    if (source[index] === "\n") line += 1;
  }
  return line;
}

export function buildNegativeBooleanNameEvidence(
  candidate: Candidate,
  projectFiles: ProjectFile[],
): NegativeBooleanNameEvidence | undefined {
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

  const booleans: NegativeBoolean[] = [];
  for (const parameter of fn.params) {
    const paramName = bindingName(parameter);
    if (!paramName) continue;
    const label = negativeLabel(paramName);
    if (!label) continue;
    const { annotation, init } = annotationOf(parameter, owner.source);
    if (!isBooleanLike(annotation, init)) continue;
    booleans.push({
      name: paramName,
      kind: "parameter",
      pattern: label,
      source: owner.source.slice(parameter.start, parameter.end).slice(0, 300),
    });
  }
  new Visitor({
    VariableDeclarator(node) {
      if (!direct(node) || node.id.type !== "Identifier") return;
      const label = negativeLabel(node.id.name);
      if (!label) return;
      const annotation = node.id.typeAnnotation
        ? owner.source
          .slice(node.id.typeAnnotation.start, node.id.typeAnnotation.end)
          .replace(/^:\s*/, "")
        : null;
      if (!isBooleanLike(annotation, node.init)) return;
      booleans.push({
        name: node.id.name,
        kind: "local",
        pattern: label,
        source: owner.source.slice(node.start, node.end).slice(0, 300),
      });
    },
  }).visit(parsed.program);

  if (booleans.length === 0) return undefined;
  const negative = new Set(booleans.map((boolean) => boolean.name));

  const negatedReads: NegatedRead[] = [];
  new Visitor({
    UnaryExpression(node) {
      if (node.operator !== "!" || node.argument.type !== "Identifier") return;
      if (!direct(node) || !negative.has(node.argument.name)) return;
      if (negatedReads.length >= 20) return;
      negatedReads.push({
        expression: owner.source.slice(node.start, node.end).slice(0, 200),
        line: lineAt(owner.source, node.start),
      });
    },
    BinaryExpression(node) {
      if (node.operator !== "===" && node.operator !== "!==") return;
      if (!direct(node)) return;
      const identifier = node.left.type === "Identifier" && negative.has(node.left.name)
        ? node.left
        : node.right.type === "Identifier" && negative.has(node.right.name)
          ? node.right
          : null;
      const other = identifier === node.left ? node.right : node.left;
      if (!identifier || !isBooleanLiteral(other)) return;
      if (negatedReads.length >= 20) return;
      negatedReads.push({
        expression: owner.source.slice(node.start, node.end).slice(0, 200),
        line: lineAt(owner.source, node.start),
      });
    },
  }).visit(parsed.program);

  return {
    function: {
      name,
      exported: isFunctionExported(parsed.program, fn, name),
      filePath: owner.filePath,
      source: candidate.source,
    },
    booleans,
    negatedReads,
    callers: findFunctionCallers(owner.filePath, name, projectFiles),
  };
}
