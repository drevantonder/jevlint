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

export type ComplexCondition = {
  line: number;
  source: string;
  logicalOperators: number;
  comparisonOperators: number;
  negations: number;
  maxDepth: number;
};

export type ExplanatoryLocal = {
  name: string;
  line: number;
};

export type UnexplainedComplexConditionEvidence = {
  function: {
    name: string;
    exported: boolean;
    filePath: string;
    source: string;
  };
  conditions: ComplexCondition[];
  explanatoryLocals: ExplanatoryLocal[];
  callers: FunctionCaller[];
};

type Range = { start: number; end: number };

function lineAt(source: string, offset: number): number {
  let line = 1;
  for (let index = 0; index < offset; index += 1) {
    if (source[index] === "\n") line += 1;
  }
  return line;
}

const COMPARISON_OPERATORS = new Set([
  "==",
  "!=",
  "===",
  "!==",
  "<",
  "<=",
  ">",
  ">=",
  "in",
  "instanceof",
]);

type ConditionFrame = {
  range: Range;
  logicalOperators: number;
  comparisonOperators: number;
  negations: number;
  maxDepth: number;
  currentDepth: number;
};

export function buildUnexplainedComplexConditionEvidence(
  candidate: Candidate,
  projectFiles: ProjectFile[],
): UnexplainedComplexConditionEvidence | undefined {
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
  const inScope = (node: Range): boolean =>
    node.start >= candidate.start && node.end <= candidate.end
    && !nested.some((range) => range.start <= node.start && range.end >= node.end);

  const conditions: Array<ComplexCondition & { start: number; end: number }> = [];
  const explanatoryLocals: ExplanatoryLocal[] = [];
  const frames: ConditionFrame[] = [];

  const innermost = (node: Range): ConditionFrame | undefined => {
    for (let index = frames.length - 1; index >= 0; index -= 1) {
      const frame = frames[index];
      if (frame && node.start >= frame.range.start && node.end <= frame.range.end) return frame;
    }
    return undefined;
  };

  const pushTest = (node: Range): void => {
    if (!inScope(node)) return;
    frames.push({
      range: { start: node.start, end: node.end },
      logicalOperators: 0,
      comparisonOperators: 0,
      negations: 0,
      maxDepth: 0,
      currentDepth: 0,
    });
  };

  const popTest = (node: Range): void => {
    if (!inScope(node)) return;
    const frame = frames.pop();
    if (frame) {
      conditions.push({
        line: lineAt(owner.source, node.start),
        source: owner.source.slice(node.start, node.end),
        logicalOperators: frame.logicalOperators,
        comparisonOperators: frame.comparisonOperators,
        negations: frame.negations,
        maxDepth: frame.maxDepth,
        start: node.start,
        end: node.end,
      });
    }
  };

  const enterOperator = (node: Range, kind: "logical" | "comparison" | "negation"): void => {
    const frame = innermost(node);
    if (!frame) return;
    if (kind === "logical") frame.logicalOperators += 1;
    if (kind === "comparison") frame.comparisonOperators += 1;
    if (kind === "negation") frame.negations += 1;
    frame.currentDepth += 1;
    if (frame.currentDepth > frame.maxDepth) frame.maxDepth = frame.currentDepth;
  };

  const exitOperator = (node: Range): void => {
    const frame = innermost(node);
    if (frame && frame.currentDepth > 0) frame.currentDepth -= 1;
  };

  new Visitor({
    IfStatement(node) {
      pushTest(node.test);
    },
    "IfStatement:exit"(node) {
      popTest(node.test);
    },
    WhileStatement(node) {
      pushTest(node.test);
    },
    "WhileStatement:exit"(node) {
      popTest(node.test);
    },
    DoWhileStatement(node) {
      pushTest(node.test);
    },
    "DoWhileStatement:exit"(node) {
      popTest(node.test);
    },
    ForStatement(node) {
      if (node.test) pushTest(node.test);
    },
    "ForStatement:exit"(node) {
      if (node.test) popTest(node.test);
    },
    ConditionalExpression(node) {
      pushTest(node.test);
    },
    "ConditionalExpression:exit"(node) {
      popTest(node.test);
    },
    LogicalExpression(node) {
      if (!inScope(node)) return;
      enterOperator(node, "logical");
    },
    "LogicalExpression:exit"(node) {
      if (!inScope(node)) return;
      exitOperator(node);
    },
    BinaryExpression(node) {
      if (!inScope(node)) return;
      if (COMPARISON_OPERATORS.has(node.operator)) enterOperator(node, "comparison");
    },
    "BinaryExpression:exit"(node) {
      if (!inScope(node)) return;
      if (COMPARISON_OPERATORS.has(node.operator)) exitOperator(node);
    },
    UnaryExpression(node) {
      if (!inScope(node)) return;
      if (node.operator === "!") enterOperator(node, "negation");
    },
    "UnaryExpression:exit"(node) {
      if (!inScope(node)) return;
      if (node.operator === "!") exitOperator(node);
    },
    VariableDeclarator(node) {
      if (!inScope(node)) return;
      if (node.id.type !== "Identifier" || !node.init) return;
      const init = node.init;
      const isBooleanValued = init.type === "LogicalExpression"
        || (init.type === "UnaryExpression" && init.operator === "!")
        || (init.type === "BinaryExpression" && COMPARISON_OPERATORS.has(init.operator));
      if (!isBooleanValued) return;
      explanatoryLocals.push({ name: node.id.name, line: lineAt(owner.source, node.start) });
    },
  }).visit(parsed.program);

  const complex = conditions.filter((entry) => entry.logicalOperators >= 2);
  if (complex.length === 0) return undefined;

  return {
    function: {
      name,
      exported: isFunctionExported(parsed.program, fn, name),
      filePath: candidate.filePath,
      source: candidate.source,
    },
    conditions: complex.map(({ line, source, logicalOperators, comparisonOperators, negations, maxDepth }) => ({
      line,
      source,
      logicalOperators,
      comparisonOperators,
      negations,
      maxDepth,
    })),
    explanatoryLocals,
    callers: findFunctionCallers(candidate.filePath, name, projectFiles),
  };
}
