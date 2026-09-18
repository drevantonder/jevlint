import { Visitor } from "oxc-parser";
import { parseCached } from "./parse-cache.js";
import type { Expression, Program } from "oxc-parser";
import type { Candidate, ProjectFile } from "../types.js";
import {
  findDirectFunction,
  findFunctionCallers,
  functionName,
  isFunctionExported,
} from "./repository.js";
import type { FunctionCaller } from "./repository.js";

type SourceRange = {
  start: number;
  end: number;
};

type BranchContext = SourceRange & {
  condition: string;
  branch: "then" | "else" | "case";
};

type SentinelReturn = {
  value: "null" | "undefined" | "-1";
  condition: string | null;
  branch: "then" | "else" | "case" | "unconditional";
};

type ValueReturn = {
  expression: string;
};

export type LossySentinelReturnEvidence = {
  function: {
    name: string;
    exported: boolean;
    filePath: string;
    source: string;
    moduleSource: string;
  };
  sentinelReturns: SentinelReturn[];
  valueReturns: ValueReturn[];
  callers: FunctionCaller[];
};

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

function sentinelValue(expression: Expression | null): SentinelReturn["value"] | undefined {
  if (!expression) return "undefined";
  if (expression.type === "Literal" && expression.value === null) return "null";
  if (expression.type === "Identifier" && expression.name === "undefined") return "undefined";
  if (expression.type === "UnaryExpression" && expression.operator === "void") return "undefined";
  if (
    expression.type === "UnaryExpression"
    && expression.operator === "-"
    && expression.argument.type === "Literal"
    && expression.argument.value === 1
  ) return "-1";
  return undefined;
}

function branchFor(node: SourceRange, contexts: BranchContext[]): BranchContext | undefined {
  return contexts
    .filter((context) => context.start <= node.start && context.end >= node.end)
    .sort((left, right) => (left.end - left.start) - (right.end - right.start))[0];
}

export function buildLossySentinelReturnEvidence(
  candidate: Candidate,
  projectFiles: ProjectFile[],
): LossySentinelReturnEvidence | undefined {
  if (candidate.kind !== "function") return undefined;
  const owner = projectFiles.find((file) => file.filePath === candidate.filePath);
  if (!owner) return undefined;
  const parsed = parseCached(owner.filePath, owner.source);
  if (parsed.errors.some((error) => error.severity === "Error")) return undefined;
  const fn = findDirectFunction(parsed.program, candidate);
  if (!fn) return undefined;
  const name = functionName(parsed.program, fn);
  if (!name) return undefined;

  const nested = nestedFunctionRanges(candidate, parsed.program);
  const contexts: BranchContext[] = [];
  new Visitor({
    IfStatement(node) {
      if (!isDirect(node, candidate, nested)) return;
      const condition = owner.source.slice(node.test.start, node.test.end);
      contexts.push({
        condition,
        branch: "then",
        start: node.consequent.start,
        end: node.consequent.end,
      });
      if (node.alternate) {
        contexts.push({
          condition,
          branch: "else",
          start: node.alternate.start,
          end: node.alternate.end,
        });
      }
    },
    SwitchCase(node) {
      if (!node.test || !isDirect(node, candidate, nested)) return;
      contexts.push({
        condition: `case ${owner.source.slice(node.test.start, node.test.end)}`,
        branch: "case",
        start: node.start,
        end: node.end,
      });
    },
  }).visit(parsed.program);

  const sentinels: Array<SentinelReturn & SourceRange> = [];
  const values: Array<ValueReturn & SourceRange> = [];
  new Visitor({
    ReturnStatement(node) {
      if (!isDirect(node, candidate, nested)) return;
      const sentinel = sentinelValue(node.argument);
      if (sentinel) {
        const context = branchFor(node, contexts);
        sentinels.push({
          value: sentinel,
          condition: context?.condition ?? null,
          branch: context?.branch ?? "unconditional",
          start: node.start,
          end: node.end,
        });
      } else if (node.argument) {
        values.push({
          expression: owner.source.slice(node.argument.start, node.argument.end),
          start: node.start,
          end: node.end,
        });
      }
    },
  }).visit(parsed.program);

  if (sentinels.length < 2 || values.length === 0) return undefined;
  sentinels.sort((left, right) => left.start - right.start);
  values.sort((left, right) => left.start - right.start);
  return {
    function: {
      name,
      exported: isFunctionExported(parsed.program, fn, name),
      filePath: owner.filePath,
      source: candidate.source,
      moduleSource: owner.source.slice(0, 16_000),
    },
    sentinelReturns: sentinels.map(({ value, condition, branch }) => ({
      value,
      condition,
      branch,
    })),
    valueReturns: values.map(({ expression }) => ({ expression })),
    callers: findFunctionCallers(candidate.filePath, name, projectFiles),
  };
}
