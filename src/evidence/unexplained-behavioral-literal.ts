import { parseSync, Visitor } from "oxc-parser";
import type { Candidate, ProjectFile } from "../types.js";
import {
  findDirectFunction,
  findFunctionCallers,
  functionName,
  isFunctionExported,
  nestedFunctionRanges,
} from "./repository.js";
import type { FunctionCaller } from "./repository.js";
import { isTestFilePath } from "./test-scope.js";

export type SteeringLiteral = {
  expression: string;
  value: string;
  kind: "number" | "string";
  position: "comparison" | "arithmetic" | "equality";
  binding: string | null;
  line: number;
};

export type UnexplainedBehavioralLiteralEvidence = {
  function: {
    name: string;
    exported: boolean;
    filePath: string;
    source: string;
  };
  literals: SteeringLiteral[];
  namedConstants: string[];
  callers: FunctionCaller[];
};

function lineAt(source: string, offset: number): number {
  let line = 1;
  for (let index = 0; index < offset; index += 1) {
    if (source[index] === "\n") line += 1;
  }
  return line;
}

const COMPARISON_OPERATORS = new Set([">", "<", ">=", "<="]);
const ARITHMETIC_OPERATORS = new Set(["+", "-", "*", "/", "%", "**"]);

function literalKind(raw: string | null): "number" | "string" | null {
  if (raw === null) return null;
  if (raw.startsWith('"') || raw.startsWith("'")) return "string";
  if (/^-?\d/.test(raw) || /^\.\d/.test(raw)) return "number";
  return null;
}

export function buildUnexplainedBehavioralLiteralEvidence(
  candidate: Candidate,
  projectFiles: ProjectFile[],
): UnexplainedBehavioralLiteralEvidence | undefined {
  if (candidate.kind !== "function") return undefined;
  if (isTestFilePath(candidate.filePath)) return undefined;
  const owner = projectFiles.find((file) => file.filePath === candidate.filePath);
  if (!owner) return undefined;
  const parsed = parseSync(owner.filePath, owner.source, { range: true });
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

  const namedConstants: string[] = [];
  new Visitor({
    VariableDeclarator(node) {
      if (!direct(node) || node.id.type !== "Identifier" || !node.init) return;
      if (node.init.type === "Literal" || node.init.type === "TemplateLiteral") {
        if (!namedConstants.includes(node.id.name)) namedConstants.push(node.id.name);
      }
    },
  }).visit(parsed.program);

  const literals: SteeringLiteral[] = [];
  const push = (
    start: number,
    end: number,
    value: string,
    kind: "number" | "string",
    position: SteeringLiteral["position"],
    binding: string | null,
  ): void => {
    literals.push({
      expression: owner.source.slice(start, end).slice(0, 200),
      value: value.slice(0, 100),
      kind,
      position,
      binding,
      line: lineAt(owner.source, start),
    });
  };

  new Visitor({
    BinaryExpression(node) {
      if (!direct(node)) return;
      const left = node.left.type === "Literal" ? node.left : null;
      const right = node.right.type === "Literal" ? node.right : null;
      const literal = left ?? right;
      const kind = literalKind(literal?.raw ?? null);
      if (!literal || !kind) return;
      const value = literal.raw ?? "";
      const other = literal === left ? node.right : node.left;
      const otherName = other.type === "Identifier" ? other.name : null;
      if (COMPARISON_OPERATORS.has(node.operator)) {
        push(node.start, node.end, value, kind, "comparison", otherName);
      } else if (node.operator === "===" || node.operator === "!==" || node.operator === "==" || node.operator === "!=") {
        push(node.start, node.end, value, kind, "equality", otherName);
      } else if (ARITHMETIC_OPERATORS.has(node.operator)) {
        if (other.type !== "Literal") {
          push(node.start, node.end, value, kind, "arithmetic", otherName);
        }
      }
    },
  }).visit(parsed.program);

  if (literals.length === 0) return undefined;

  const seen = new Set<string>();
  const unique = literals.filter((literal) => {
    const key = `${literal.line}:${literal.expression}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });

  return {
    function: {
      name,
      exported: isFunctionExported(parsed.program, fn, name),
      filePath: candidate.filePath,
      source: candidate.source,
    },
    literals: unique.slice(0, 20),
    namedConstants: namedConstants.slice(0, 10),
    callers: findFunctionCallers(candidate.filePath, name, projectFiles),
  };
}
