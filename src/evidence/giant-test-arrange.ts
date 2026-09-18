import { Visitor } from "oxc-parser";
import { parseCached } from "./parse-cache.js";
import type { CallExpression, Node } from "oxc-parser";
import type { Candidate, ProjectFile } from "../types.js";
import {
  isInsideNestedFunction,
  nestedFunctionRanges,
} from "./repository.js";
import { isTestFilePath, parseTestFunction } from "./test-scope.js";

export type FactoryHelperEvidence = {
  filePath: string;
  name: string;
};

export type GiantTestArrangeEvidence = {
  function: {
    title: string | null;
    filePath: string;
    source: string;
    moduleSource: string;
  };
  arrangeStatements: number;
  arrangeLines: number;
  objectLiteralProps: number;
  largestInlineLiteral: number;
  assertionCount: number;
  factoryHelpers: FactoryHelperEvidence[];
};

function isAssertion(call: CallExpression): boolean {
  if (call.callee.type !== "Identifier") return false;
  return call.callee.name === "expect" || call.callee.name === "assert";
}

function collectFactoryHelpers(
  ownerPath: string,
  projectFiles: ProjectFile[],
): FactoryHelperEvidence[] {
  const helpers: FactoryHelperEvidence[] = [];
  for (const file of projectFiles) {
    if (!isTestFilePath(file.filePath)) continue;
    const parsed = parseCached(file.filePath, file.source);
    if (parsed.errors.some((error) => error.severity === "Error")) continue;
    const add = (name: string): void => {
      if (!/fixture|factory|create[A-Z]|make[A-Z]|build[A-Z]|setup/i.test(name)) return;
      if (helpers.length >= 10) return;
      helpers.push({ filePath: file.filePath, name });
    };
    new Visitor({
      FunctionDeclaration(node) {
        if (node.id?.name) add(node.id.name);
      },
      VariableDeclarator(node) {
        if (node.id.type !== "Identifier" || !node.init) return;
        if (
          node.init.type === "ArrowFunctionExpression"
          || node.init.type === "FunctionExpression"
        ) add(node.id.name);
      },
    }).visit(parsed.program);
  }
  void ownerPath;
  return helpers;
}

export function buildGiantTestArrangeEvidence(
  candidate: Candidate,
  projectFiles: ProjectFile[],
): GiantTestArrangeEvidence | undefined {
  const scope = parseTestFunction(candidate, projectFiles);
  if (!scope) return undefined;
  if (scope.runner !== "it" && scope.runner !== "test") return undefined;
  const { owner, program, fn } = scope;
  const nested = nestedFunctionRanges(program, candidate);

  let firstAssertionStart: number | null = null;
  let assertionCount = 0;
  new Visitor({
    CallExpression(call) {
      if (call.start < fn.start || call.end > fn.end) return;
      if (isInsideNestedFunction(call, nested)) return;
      if (!isAssertion(call)) return;
      assertionCount += 1;
      if (firstAssertionStart === null || call.start < firstAssertionStart) {
        firstAssertionStart = call.start;
      }
    },
  }).visit(program);

  if (assertionCount === 0 || firstAssertionStart === null) return undefined;

  const arrangeEnd = firstAssertionStart;
  let arrangeStatements = 0;
  let objectLiteralProps = 0;
  let largestInlineLiteral = 0;
  const countInArrange = (node: Node): boolean => {
    if (node.start < fn.start || node.end > arrangeEnd) return false;
    return !isInsideNestedFunction(node, nested);
  };
  const countStatement = (node: Node): void => {
    if (countInArrange(node)) arrangeStatements += 1;
  };
  new Visitor({
    VariableDeclaration: countStatement,
    ExpressionStatement: countStatement,
    IfStatement: countStatement,
    ForStatement: countStatement,
    ForInStatement: countStatement,
    ForOfStatement: countStatement,
    WhileStatement: countStatement,
    DoWhileStatement: countStatement,
    SwitchStatement: countStatement,
    TryStatement: countStatement,
    ReturnStatement: countStatement,
    ThrowStatement: countStatement,
    ObjectExpression(node) {
      if (!countInArrange(node)) return;
      objectLiteralProps += node.properties.length;
      if (node.properties.length > largestInlineLiteral) {
        largestInlineLiteral = node.properties.length;
      }
    },
  }).visit(program);

  if (arrangeStatements === 0) return undefined;

  const arrangeSource = owner.source.slice(fn.start, arrangeEnd);
  const arrangeLines = arrangeSource.split("\n").length;

  return {
    function: {
      title: scope.title,
      filePath: candidate.filePath,
      source: candidate.source,
      moduleSource: owner.source.slice(0, 16_000),
    },
    arrangeStatements,
    arrangeLines,
    objectLiteralProps,
    largestInlineLiteral,
    assertionCount,
    factoryHelpers: collectFactoryHelpers(owner.filePath, projectFiles),
  };
}
