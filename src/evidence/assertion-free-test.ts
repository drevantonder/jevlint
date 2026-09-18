import { Visitor } from "oxc-parser";
import { parseCached } from "./parse-cache.js";
import type { CallExpression } from "oxc-parser";
import type { Candidate, ProjectFile } from "../types.js";
import {
  calleeRootName,
  isInsideNestedFunction,
  nestedFunctionRanges,
} from "./repository.js";
import { isTestFilePath, parseTestFunction } from "./test-scope.js";

export type SiblingAssertionNorm = {
  subject: string;
  assertingTests: number;
  files: string[];
};

export type AssertionFreeTestEvidence = {
  function: {
    title: string | null;
    filePath: string;
    source: string;
    moduleSource: string;
  };
  assertionCalls: string[];
  subjectCalls: string[];
  smokeContract: boolean;
  repository: {
    siblingAssertionNorm: SiblingAssertionNorm[];
  };
};

const ASSERTION_ROOTS = new Set(["expect", "assert", "chai"]);
const FRAMEWORK_ROOTS = new Set([
  "describe",
  "it",
  "test",
  "beforeEach",
  "afterEach",
  "beforeAll",
  "afterAll",
  "vi",
  "vitest",
  "jest",
  "expect",
  "assert",
  "cy",
]);

const ASSERTION_METHODS = new Set([
  "ok",
  "equal",
  "notEqual",
  "strictEqual",
  "notStrictEqual",
  "deepEqual",
  "notDeepEqual",
  "deepStrictEqual",
  "match",
  "throws",
  "doesNotThrow",
  "rejects",
  "resolves",
  "snapshot",
  "matchSnapshot",
  "toMatchSnapshot",
  "toMatchInlineSnapshot",
  "fail",
]);

function callText(call: CallExpression, source: string): string {
  return source.slice(call.start, call.end);
}

function isAssertionCall(call: CallExpression): boolean {
  const root = calleeRootName(call.callee);
  if (root && ASSERTION_ROOTS.has(root)) return true;
  const callee = call.callee;
  const property = callee.type === "MemberExpression" && callee.property.type === "Identifier"
    ? callee.property.name
    : null;
  if (property && (ASSERTION_METHODS.has(property) || /^to[A-Z]/.test(property))) return true;
  return false;
}

function siblingAssertionNorm(
  subject: string,
  ownerPath: string,
  projectFiles: ProjectFile[],
): SiblingAssertionNorm {
  let assertingTests = 0;
  const files = new Set<string>();
  for (const file of projectFiles) {
    if (file.filePath === ownerPath || !isTestFilePath(file.filePath)) continue;
    const parsed = parseCached(file.filePath, file.source);
    if (parsed.errors.some((error) => error.severity === "Error")) continue;
    let assertsOnSubject = false;
    let touchesSubject = false;
    new Visitor({
      CallExpression(call) {
        const text = file.source.slice(call.start, call.end);
        if (text.includes(subject)) touchesSubject = true;
        if (isAssertionCall(call) && text.includes(subject)) assertsOnSubject = true;
      },
    }).visit(parsed.program);
    if (touchesSubject && assertsOnSubject) {
      assertingTests += 1;
      files.add(file.filePath);
    }
  }
  return { subject, assertingTests, files: [...files] };
}

export function buildAssertionFreeTestEvidence(
  candidate: Candidate,
  projectFiles: ProjectFile[],
): AssertionFreeTestEvidence | undefined {
  const scope = parseTestFunction(candidate, projectFiles);
  if (!scope) return undefined;
  if (scope.runner !== "it" && scope.runner !== "test") return undefined;
  const { owner, program, fn } = scope;
  const nested = nestedFunctionRanges(program, candidate);

  const assertionCalls: string[] = [];
  const subjectCalls: string[] = [];
  new Visitor({
    CallExpression(call) {
      if (call.start < fn.start || call.end > fn.end) return;
      if (isInsideNestedFunction(call, nested)) return;
      if (isAssertionCall(call)) {
        assertionCalls.push(callText(call, owner.source));
        return;
      }
      const root = calleeRootName(call.callee);
      if (root && FRAMEWORK_ROOTS.has(root)) return;
      subjectCalls.push(callText(call, owner.source));
    },
  }).visit(program);

  if (assertionCalls.length > 0) return undefined;
  if (subjectCalls.length === 0) return undefined;

  const subjects = [...new Set(
    subjectCalls.map((text) => text.split("(")[0]?.trim() ?? text).filter((name) => name.length > 0),
  )].slice(0, 5);
  const norms = subjects.map((subject) => siblingAssertionNorm(subject, owner.filePath, projectFiles));
  const title = scope.title ?? "";
  return {
    function: {
      title: scope.title,
      filePath: candidate.filePath,
      source: candidate.source,
      moduleSource: owner.source.slice(0, 16_000),
    },
    assertionCalls,
    subjectCalls: subjectCalls.slice(0, 10),
    smokeContract: /smoke|import|loads?|does not crash|starts? up/i.test(title),
    repository: {
      siblingAssertionNorm: norms.filter((norm) => norm.assertingTests > 0),
    },
  };
}
