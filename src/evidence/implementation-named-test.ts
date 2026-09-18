import { Visitor } from "oxc-parser";
import type { CallExpression } from "oxc-parser";
import type { Candidate, ProjectFile } from "../types.js";
import {
  calleeRootName,
  isInsideNestedFunction,
  moduleImports,
  nestedFunctionRanges,
} from "./repository.js";
import { parseTestFunction } from "./test-scope.js";

export type ImplementationNamedTestImport = {
  local: string;
  imported: string;
  from: string;
};

export type ImplementationNamedTestTitle = {
  runner: string;
  title: string;
};

export type ImplementationNamedTestEvidence = {
  test: {
    title: string;
    runner: "it" | "test" | "describe";
    filePath: string;
    source: string;
    moduleSource: string;
  };
  fileStem: string;
  imports: ImplementationNamedTestImport[];
  titles: ImplementationNamedTestTitle[];
  subjectCalls: string[];
  assertionCalls: string[];
};

const TITLE_RUNNERS = new Set(["describe", "it", "test"]);
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

const TITLE_CHARS = 240;
const CALL_CHARS = 240;

function fileStemOf(filePath: string): string {
  const base = filePath.replaceAll("\\", "/").split("/").pop() ?? filePath;
  return base.replace(/\.[cm]?[jt]sx?$/i, "").replace(/\.(test|spec)$/i, "");
}

function quotedTitle(source: string, call: CallExpression): string | null {
  const first = call.arguments[0];
  if (!first || first.type === "SpreadElement" || first.type !== "Literal") return null;
  const raw = source.slice(first.start, first.end);
  const quote = raw[0];
  if (quote !== "\"" && quote !== "'" && quote !== "`") return null;
  if (raw.length < 2 || raw[raw.length - 1] !== quote) return null;
  if (quote === "`" && raw.includes("${")) return null;
  return raw.slice(1, -1);
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

export function buildImplementationNamedTestEvidence(
  candidate: Candidate,
  projectFiles: ProjectFile[],
): ImplementationNamedTestEvidence | undefined {
  const scope = parseTestFunction(candidate, projectFiles);
  if (!scope) return undefined;
  if (scope.runner !== "it" && scope.runner !== "test" && scope.runner !== "describe") {
    return undefined;
  }
  if (scope.title === null) return undefined;
  const { owner, program, fn } = scope;
  const nested = nestedFunctionRanges(program, candidate);

  const titles: ImplementationNamedTestTitle[] = [];
  new Visitor({
    CallExpression(call) {
      const root = calleeRootName(call.callee);
      if (!root || !TITLE_RUNNERS.has(root)) return;
      const title = quotedTitle(owner.source, call);
      if (title === null) return;
      titles.push({ runner: root, title: title.slice(0, TITLE_CHARS) });
      if (titles.length >= 25) return;
    },
  }).visit(program);

  const subjectCalls: string[] = [];
  const assertionCalls: string[] = [];
  new Visitor({
    CallExpression(call) {
      if (call.start < fn.start || call.end > fn.end) return;
      if (isInsideNestedFunction(call, nested)) return;
      if (isAssertionCall(call)) {
        assertionCalls.push(owner.source.slice(call.start, call.end).slice(0, CALL_CHARS));
        return;
      }
      const root = calleeRootName(call.callee);
      if (root && FRAMEWORK_ROOTS.has(root)) return;
      subjectCalls.push(owner.source.slice(call.start, call.end).slice(0, CALL_CHARS));
    },
  }).visit(program);

  return {
    test: {
      title: scope.title,
      runner: scope.runner,
      filePath: candidate.filePath,
      source: candidate.source,
      moduleSource: owner.source.slice(0, 16_000),
    },
    fileStem: fileStemOf(candidate.filePath),
    imports: moduleImports(program)
      .map(({ local, imported, source }) => ({
        local,
        imported,
        from: source,
      }))
      .slice(0, 25),
    titles,
    subjectCalls: subjectCalls.slice(0, 10),
    assertionCalls: assertionCalls.slice(0, 10),
  };
}
