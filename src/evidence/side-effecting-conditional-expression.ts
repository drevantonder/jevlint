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

export type ConditionalExpressionEvidence = {
  line: number;
  source: string;
  nestingDepth: number;
  consequentEffects: string[];
  alternateEffects: string[];
};

export type LogicalStatementEvidence = {
  line: number;
  source: string;
  operator: string;
  effect: string;
};

export type SideEffectingConditionalEvidence = {
  function: {
    name: string;
    exported: boolean;
    filePath: string;
    source: string;
  };
  conditionals: ConditionalExpressionEvidence[];
  logicalStatements: LogicalStatementEvidence[];
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

type ConditionalFrame = {
  consequent: Range;
  alternate: Range;
  depth: number;
  consequentEffects: string[];
  alternateEffects: string[];
  discarded: boolean;
  hasNested: boolean;
  hasMutation: boolean;
};

type SmellyMeta = {
  discarded: boolean;
  hasNested: boolean;
  hasMutation: boolean;
};

export function buildSideEffectingConditionalEvidence(
  candidate: Candidate,
  projectFiles: ProjectFile[],
): SideEffectingConditionalEvidence | undefined {
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

  const conditionals: Array<ConditionalExpressionEvidence & { start: number; end: number } & SmellyMeta> = [];
  const logicalStatements: LogicalStatementEvidence[] = [];
  const frames: ConditionalFrame[] = [];
  let conditionalDepth = 0;
  const discardedRanges = new Set<string>();

  const rangeKey = (node: Range): string => `${node.start}:${node.end}`;

  const describeEffect = (node: Range): string => owner.source.slice(node.start, node.end);

  const markEffect = (node: Range, isMutation: boolean): void => {
    for (let index = frames.length - 1; index >= 0; index -= 1) {
      const frame = frames[index];
      if (!frame) continue;
      if (node.start >= frame.consequent.start && node.end <= frame.consequent.end) {
        frame.consequentEffects.push(describeEffect(node));
        if (isMutation) frame.hasMutation = true;
        return;
      }
      if (node.start >= frame.alternate.start && node.end <= frame.alternate.end) {
        frame.alternateEffects.push(describeEffect(node));
        if (isMutation) frame.hasMutation = true;
        return;
      }
    }
  };

  new Visitor({
    ConditionalExpression(node) {
      if (!inScope(node)) return;
      conditionalDepth += 1;
      const parent = frames[frames.length - 1];
      if (parent) parent.hasNested = true;
      frames.push({
        consequent: { start: node.consequent.start, end: node.consequent.end },
        alternate: { start: node.alternate.start, end: node.alternate.end },
        depth: conditionalDepth,
        consequentEffects: [],
        alternateEffects: [],
        discarded: discardedRanges.has(rangeKey(node)) || parent?.discarded === true,
        hasNested: false,
        hasMutation: false,
      });
    },
    "ConditionalExpression:exit"(node) {
      if (!inScope(node)) return;
      const frame = frames.pop();
      conditionalDepth -= 1;
      if (frame) {
        conditionals.push({
          line: lineAt(owner.source, node.start),
          source: owner.source.slice(node.start, node.end),
          nestingDepth: frame.depth,
          consequentEffects: frame.consequentEffects,
          alternateEffects: frame.alternateEffects,
          discarded: frame.discarded,
          hasNested: frame.hasNested,
          hasMutation: frame.hasMutation,
          start: node.start,
          end: node.end,
        });
      }
    },
    CallExpression(node) {
      if (!inScope(node)) return;
      markEffect(node, false);
    },
    AssignmentExpression(node) {
      if (!inScope(node)) return;
      markEffect(node, true);
    },
    UpdateExpression(node) {
      if (!inScope(node)) return;
      markEffect(node, true);
    },
    ExpressionStatement(node) {
      if (!inScope(node)) return;
      const expression = node.expression;
      if (expression.type === "ConditionalExpression") {
        discardedRanges.add(rangeKey(expression));
      }
      if (expression.type !== "LogicalExpression") return;
      if (expression.operator === "??") return;
      const right = owner.source.slice(expression.right.start, expression.right.end);
      const hasEffect = expression.right.type === "CallExpression"
        || expression.right.type === "AssignmentExpression"
        || expression.right.type === "UpdateExpression"
        || expression.right.type === "AwaitExpression";
      if (!hasEffect) return;
      logicalStatements.push({
        line: lineAt(owner.source, node.start),
        source: owner.source.slice(node.start, node.end),
        operator: expression.operator,
        effect: right,
      });
    },
  }).visit(parsed.program);

  // A flat ternary whose value is used (assigned, returned, passed along) and whose
  // arms only call functions is value selection: the calls compute the selected
  // value. Only discarded-position calls (a bare `cond ? a() : b();` statement),
  // arm mutations, or nesting readers must execute count as this smell.
  const smelly = conditionals.filter(
    (entry) => entry.nestingDepth >= 2
      || entry.hasNested
      || entry.hasMutation
      || ((entry.consequentEffects.length > 0 || entry.alternateEffects.length > 0) && entry.discarded),
  );
  if (smelly.length === 0 && logicalStatements.length === 0) return undefined;

  return {
    function: {
      name,
      exported: isFunctionExported(parsed.program, fn, name),
      filePath: candidate.filePath,
      source: candidate.source,
    },
    conditionals: smelly.map(({ line, source, nestingDepth, consequentEffects, alternateEffects }) => ({
      line,
      source,
      nestingDepth,
      consequentEffects,
      alternateEffects,
    })),
    logicalStatements,
    callers: findFunctionCallers(candidate.filePath, name, projectFiles),
  };
}
