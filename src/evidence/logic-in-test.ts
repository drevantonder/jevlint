import { Visitor } from "oxc-parser";
import type { CallExpression } from "oxc-parser";
import type { Candidate, ProjectFile } from "../types.js";
import {
  calleeRootName,
  isInsideNestedFunction,
  moduleImports,
  nestedFunctionRanges,
  resolveModule,
} from "./repository.js";
import { parseTestFunction } from "./test-scope.js";

export type TestLogicEvidence = {
  kind: "if" | "conditional" | "switch" | "loop";
  condition: string;
  body: string;
  assertionsInside: string[];
};

export type LogicInTestEvidence = {
  function: {
    title: string | null;
    filePath: string;
    source: string;
    moduleSource: string;
  };
  logic: TestLogicEvidence[];
  dataTable: boolean;
  mirrorsSubjectPredicate: boolean;
  repository: {
    subjectConditionOverlap: string[];
  };
};

const TEST_EACH = new Set(["describe", "it", "test"]);

function isAssertionLike(call: CallExpression): boolean {
  const root = calleeRootName(call.callee);
  if (root === "expect" || root === "assert") return true;
  const callee = call.callee;
  const property = callee.type === "MemberExpression" && callee.property.type === "Identifier"
    ? callee.property.name
    : null;
  return property !== null && (property === "ok" || /^to[A-Z]/.test(property));
}

function conditionIdentifiers(condition: string): string[] {
  const names = new Set<string>();
  for (const match of condition.matchAll(/\b[A-Za-z_$][\w$]*\b/g)) {
    const name = match[0];
    if (!["true", "false", "null", "undefined"].includes(name)) names.add(name);
  }
  return [...names];
}

export function buildLogicInTestEvidence(
  candidate: Candidate,
  projectFiles: ProjectFile[],
): LogicInTestEvidence | undefined {
  const scope = parseTestFunction(candidate, projectFiles);
  if (!scope) return undefined;
  if (scope.runner !== "it" && scope.runner !== "test") return undefined;
  const { owner, program, fn } = scope;
  const nested = nestedFunctionRanges(program, candidate);
  const inScope = (start: number, end: number): boolean =>
    start >= fn.start && end <= fn.end;

  const logic: TestLogicEvidence[] = [];
  const seen = new Set<number>();
  const push = (
    kind: TestLogicEvidence["kind"],
    start: number,
    end: number,
    condition: string,
    body: string,
  ): void => {
    if (seen.has(start)) return;
    seen.add(start);
    const assertionsInside: string[] = [];
    new Visitor({
      CallExpression(call) {
        if (call.start < start || call.end > end) return;
        if (isAssertionLike(call)) {
          assertionsInside.push(owner.source.slice(call.start, call.end));
        }
      },
    }).visit(program);
    logic.push({
      kind,
      condition,
      body: body.slice(0, 500),
      assertionsInside: assertionsInside.slice(0, 5),
    });
  };

  new Visitor({
    IfStatement(node) {
      if (!inScope(node.start, node.end) || isInsideNestedFunction(node, nested)) return;
      push(
        "if",
        node.start,
        node.end,
        owner.source.slice(node.test.start, node.test.end),
        owner.source.slice(node.consequent.start, node.consequent.end),
      );
    },
    ConditionalExpression(node) {
      if (!inScope(node.start, node.end) || isInsideNestedFunction(node, nested)) return;
      push(
        "conditional",
        node.start,
        node.end,
        owner.source.slice(node.test.start, node.test.end),
        owner.source.slice(node.start, node.end),
      );
    },
    SwitchStatement(node) {
      if (!inScope(node.start, node.end) || isInsideNestedFunction(node, nested)) return;
      push(
        "switch",
        node.start,
        node.end,
        owner.source.slice(node.discriminant.start, node.discriminant.end),
        owner.source.slice(node.start, node.end),
      );
    },
    ForStatement(node) {
      if (!inScope(node.start, node.end) || isInsideNestedFunction(node, nested)) return;
      push("loop", node.start, node.end, "for", owner.source.slice(node.start, node.end));
    },
    ForOfStatement(node) {
      if (!inScope(node.start, node.end) || isInsideNestedFunction(node, nested)) return;
      push("loop", node.start, node.end, "for-of", owner.source.slice(node.start, node.end));
    },
    ForInStatement(node) {
      if (!inScope(node.start, node.end) || isInsideNestedFunction(node, nested)) return;
      push("loop", node.start, node.end, "for-in", owner.source.slice(node.start, node.end));
    },
    WhileStatement(node) {
      if (!inScope(node.start, node.end) || isInsideNestedFunction(node, nested)) return;
      push("loop", node.start, node.end, "while", owner.source.slice(node.start, node.end));
    },
    DoWhileStatement(node) {
      if (!inScope(node.start, node.end) || isInsideNestedFunction(node, nested)) return;
      push("loop", node.start, node.end, "do-while", owner.source.slice(node.start, node.end));
    },
  }).visit(program);

  let dataTable = false;
  new Visitor({
    CallExpression(call) {
      if (dataTable) return;
      let applied = call.callee;
      while (applied.type === "CallExpression") applied = applied.callee;
      if (applied.type !== "MemberExpression" || applied.property.type !== "Identifier") return;
      if (applied.property.name !== "each") return;
      const root = calleeRootName(applied.object);
      if (root && TEST_EACH.has(root)) dataTable = true;
    },
  }).visit(program);

  if (logic.length === 0 && !dataTable) return undefined;

  const imports = moduleImports(program);
  const subjectSources = imports
    .filter((entry) => entry.source.startsWith("."))
    .map((entry) => resolveModule(owner.filePath, entry.source, projectFiles))
    .filter((target) => target !== undefined)
    .map((target) => target.source);
  const overlap: string[] = [];
  for (const item of logic) {
    for (const name of conditionIdentifiers(item.condition)) {
      if (name.length > 2 && subjectSources.some((source) => source.includes(name))) {
        overlap.push(name);
      }
    }
  }
  const subjectConditionOverlap = [...new Set(overlap)].slice(0, 10);

  return {
    function: {
      title: scope.title,
      filePath: candidate.filePath,
      source: candidate.source,
      moduleSource: owner.source.slice(0, 16_000),
    },
    logic,
    dataTable,
    mirrorsSubjectPredicate: subjectConditionOverlap.length > 0,
    repository: { subjectConditionOverlap },
  };
}
