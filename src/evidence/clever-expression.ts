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

export type CleverFinding = {
  line: number;
  kind: "assignment-in-test" | "sequence" | "bitwise" | "chained-assignment";
  source: string;
};

export type CleverExpressionEvidence = {
  function: {
    name: string;
    exported: boolean;
    filePath: string;
    source: string;
  };
  findings: CleverFinding[];
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

const BITWISE_OPERATORS = new Set(["&", "|", "^", "<<", ">>", ">>>"]);

export function buildCleverExpressionEvidence(
  candidate: Candidate,
  projectFiles: ProjectFile[],
): CleverExpressionEvidence | undefined {
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

  const findings: CleverFinding[] = [];
  const testRanges: Range[] = [];
  const assignmentStack: Range[] = [];

  const pushTest = (node: Range): void => {
    if (!inScope(node)) return;
    testRanges.push({ start: node.start, end: node.end });
  };
  const popTest = (node: Range): void => {
    if (!inScope(node)) return;
    testRanges.pop();
  };
  const insideTest = (node: Range): boolean =>
    testRanges.some((range) => range.start <= node.start && range.end >= node.end);

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
    AssignmentExpression(node) {
      if (!inScope(node)) return;
      const chained = assignmentStack.some(
        (range) => range.start <= node.start && range.end >= node.end,
      );
      if (chained) {
        findings.push({
          line: lineAt(owner.source, node.start),
          kind: "chained-assignment",
          source: owner.source.slice(node.start, node.end),
        });
      } else if (insideTest(node)) {
        findings.push({
          line: lineAt(owner.source, node.start),
          kind: "assignment-in-test",
          source: owner.source.slice(node.start, node.end),
        });
      }
      assignmentStack.push({ start: node.start, end: node.end });
    },
    "AssignmentExpression:exit"(node) {
      if (!inScope(node)) return;
      assignmentStack.pop();
    },
    SequenceExpression(node) {
      if (!inScope(node)) return;
      findings.push({
        line: lineAt(owner.source, node.start),
        kind: "sequence",
        source: owner.source.slice(node.start, node.end),
      });
    },
    BinaryExpression(node) {
      if (!inScope(node)) return;
      if (!BITWISE_OPERATORS.has(node.operator)) return;
      findings.push({
        line: lineAt(owner.source, node.start),
        kind: "bitwise",
        source: owner.source.slice(node.start, node.end),
      });
    },
    UnaryExpression(node) {
      if (!inScope(node)) return;
      if (node.operator !== "~") return;
      findings.push({
        line: lineAt(owner.source, node.start),
        kind: "bitwise",
        source: owner.source.slice(node.start, node.end),
      });
    },
  }).visit(parsed.program);

  if (findings.length === 0) return undefined;

  return {
    function: {
      name,
      exported: isFunctionExported(parsed.program, fn, name),
      filePath: candidate.filePath,
      source: candidate.source,
    },
    findings,
    callers: findFunctionCallers(candidate.filePath, name, projectFiles),
  };
}
