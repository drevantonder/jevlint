import { Visitor } from "oxc-parser";
import type { Argument, Expression, Program } from "oxc-parser";
import { parseCached } from "./parse-cache.js";
import type { ProjectFile } from "../types.js";

// Content-signal test scope.
//
// jevlint used to split production from test files by directory and filename
// patterns (__tests__/, test/, tests/, spec/, e2e/, *.test.*). Any
// directory-name gate mis-splits prod vs test somewhere: real codebases keep
// tests at the root, under lib/, in packages/*/src mixes, or in e2e files
// with no .test. segment, while fixture apps and data under test/ dirs are
// production code for review purposes. Worse, each rule carried its own copy
// of the pattern, so the same file split differently per rule.
//
// This module is the single classifier every rule delegates to. A file is a
// test file when one of three content-cheap signals fires, in order:
//   1. Filename pre-pass: a .test. or .spec. basename segment. Zero parse
//      cost; covers the universal colocated/dir convention (including every
//      fixture layout jevlint validates against, so those evidence shapes
//      do not move).
//   2. Test-framework import: a static import, require(), or dynamic
//      import() of a known runner package (vitest, jest, mocha,
//      node:test, @playwright/test, ...). Importing a runner is the
//      strongest layout-independent signal a file exercises code.
//   3. Test-global usage: calls to runner globals (expect, describe, hooks,
//      title-shaped it/test/suite/context, cy/vi/jest helpers). Covers
//      suites that rely on injected globals with no import.
// Deliberately NOT signals, with reasons:
//   - Directory names (test/, __tests__/, e2e/, ...): the gate being
//     removed; fixture apps under test dirs are prod code.
//   - Bare assert() calls: production code uses node:assert for invariants,
//     so assert alone would mis-split prod as test — the mirrored failure.
//     Assertion libraries surface through signals 2 and 3 instead
//     (imported expect, global expect).

const TEST_FILENAME_PATTERN = /(^|\.)(test|spec)\.[cm]?[jt]sx?$/i;

export function isTestFilename(filePath: string): boolean {
  const normalized = filePath.replaceAll("\\", "/");
  const base = normalized.split("/").pop() ?? normalized;
  return TEST_FILENAME_PATTERN.test(base);
}

// Runner packages whose import marks the importing file as a test file.
// Subpaths match (vitest/globals, @playwright/test types, ...). Relative,
// absolute, URL, and other node: specifiers never match. node:assert is
// excluded on purpose: production invariant code imports it.
const TEST_FRAMEWORK_ROOTS: ReadonlySet<string> = new Set([
  "ava",
  "bun:test",
  "cucumber",
  "@cucumber/cucumber",
  "cypress",
  "intern",
  "jasmine",
  "jest",
  "@jest/globals",
  "karma",
  "mocha",
  "nightwatch",
  "node:test",
  "playwright",
  "@playwright/test",
  "protractor",
  "qunit",
  "tap",
  "tape",
  "testcafe",
  "uvu",
  "vitest",
  "webdriverio",
]);

export function isTestFrameworkSpecifier(specifier: string): boolean {
  if (specifier.startsWith(".") || specifier.startsWith("/") || specifier.includes("://")) {
    return false;
  }
  if (specifier.startsWith("node:")) return specifier === "node:test";
  if (specifier.startsWith("bun:")) return specifier === "bun:test";
  const root = specifier.startsWith("@")
    ? specifier.split("/").slice(0, 2).join("/")
    : specifier.split("/")[0] ?? "";
  return TEST_FRAMEWORK_ROOTS.has(root);
}

// Globals no production module calls: assertion and lifecycle entry points
// the runner injects.
const TEST_GLOBAL_ANY_CALL: ReadonlySet<string> = new Set([
  "afterAll",
  "afterEach",
  "beforeAll",
  "beforeEach",
  "describe",
  "expect",
]);

// Runner cases take a string title plus a function body: it("...", () =>).
// The title shape keeps a production helper coincidentally named test()
// (called with values, not a title) from classifying as a test file.
const TEST_GLOBAL_TITLE_CALL: ReadonlySet<string> = new Set([
  "context",
  "it",
  "suite",
  "test",
]);

// Helper namespaces no production module touches as a global.
const TEST_OBJECT_ANY_CALL: ReadonlySet<string> = new Set(["cy", "jest", "vi"]);

function rawOf(source: string, node: { start: number; end: number }): string {
  return source.slice(node.start, node.end);
}

function isQuoted(raw: string): string | undefined {
  const quote = raw[0];
  if (quote !== "\"" && quote !== "'" && quote !== "`") return undefined;
  if (raw.length < 2 || raw[raw.length - 1] !== quote) return undefined;
  if (quote === "`" && raw.includes("${")) return undefined;
  return raw.slice(1, -1);
}

function isStringTitle(source: string, argument: Argument | undefined): boolean {
  if (!argument || argument.type === "SpreadElement") return false;
  const value = argument.type === "ChainExpression" ? argument.expression : argument;
  if (value.type === "Literal" || value.type === "TemplateLiteral") {
    return isQuoted(rawOf(source, value)) !== undefined;
  }
  return false;
}

function calleeTestSignal(callee: Expression): boolean {
  const unwrapped = callee.type === "ChainExpression" ? callee.expression : callee;
  if (unwrapped.type === "Identifier") {
    if (TEST_GLOBAL_ANY_CALL.has(unwrapped.name)) return true;
    return false;
  }
  if (unwrapped.type !== "MemberExpression" || unwrapped.computed) return false;
  if (unwrapped.object.type !== "Identifier") return false;
  if (unwrapped.property.type !== "Identifier") return false;
  if (TEST_OBJECT_ANY_CALL.has(unwrapped.object.name)) return true;
  if (unwrapped.object.name === "Deno" && unwrapped.property.name === "test") return true;
  return false;
}

function calleeTitleSignal(source: string, callee: Expression, first: Argument | undefined): boolean {
  const unwrapped = callee.type === "ChainExpression" ? callee.expression : callee;
  if (unwrapped.type === "Identifier") {
    return TEST_GLOBAL_TITLE_CALL.has(unwrapped.name) && isStringTitle(source, first);
  }
  if (unwrapped.type !== "MemberExpression" || unwrapped.computed) return false;
  if (unwrapped.object.type !== "Identifier") return false;
  if (unwrapped.property.type !== "Identifier") return false;
  if (!TEST_GLOBAL_TITLE_CALL.has(unwrapped.object.name)
    && unwrapped.object.name !== "describe") return false;
  return isStringTitle(source, first);
}

/** True when a parsed program imports a test runner or calls runner
 * globals. Runs on the shared parse cache entry, so classification piggybacks
 * on parsing the caller scan already performs. String shapes (titles,
 * specifiers) read from the source slice, matching the repo's literal
 * handling elsewhere. */
export function programHasTestSignals(program: Program, source: string): boolean {
  let found = false;
  new Visitor({
    ImportDeclaration(node) {
      if (!found && isTestFrameworkSpecifier(node.source.value)) found = true;
    },
    CallExpression(node) {
      if (found) return;
      const callee = node.callee.type === "ChainExpression" ? node.callee.expression : node.callee;
      if (callee.type === "Identifier" && callee.name === "require") {
        const first = node.arguments[0];
        const value = first && first.type !== "SpreadElement" ? first : undefined;
        const inner = value && value.type === "ChainExpression" ? value.expression : value;
        if (inner && inner.type === "Literal") {
          const specifier = isQuoted(rawOf(source, inner));
          if (specifier !== undefined && isTestFrameworkSpecifier(specifier)) found = true;
        }
        return;
      }
      if (calleeTestSignal(node.callee)) {
        found = true;
        return;
      }
      if (calleeTitleSignal(source, node.callee, node.arguments[0])) found = true;
    },
    ImportExpression(node) {
      if (found) return;
      if (node.source.type !== "Literal") return;
      const specifier = isQuoted(rawOf(source, node.source));
      if (specifier !== undefined && isTestFrameworkSpecifier(specifier)) found = true;
    },
  }).visit(program);
  return found;
}

// Classification memo: tree-wide norms re-ask per candidate, and the answer
// only changes when the source does. Keyed by path; entries hold the source
// they were computed from so stale entries recompute instead of lying.
const contentCache = new Map<string, { source: string; result: boolean }>();

export function clearTestSignalCache(): void {
  contentCache.clear();
}

/** Filename pre-pass first (no parse), content sniff second (shared cached
 * parse). Files that fail to parse classify by filename alone. */
export function isTestFileContent(filePath: string, source: string): boolean {
  if (isTestFilename(filePath)) return true;
  const cached = contentCache.get(filePath);
  if (cached !== undefined && cached.source === source) return cached.result;
  const parsed = parseCached(filePath, source);
  const result = parsed.errors.some((error) => error.severity === "Error")
    ? false
    : programHasTestSignals(parsed.program, source);
  contentCache.set(filePath, { source, result });
  return result;
}

/** Tree lookup with a filename fallback for paths absent from the tree
 * (import edges and caller records referencing files outside collection). */
export function isTestProjectFile(filePath: string, projectFiles: ProjectFile[]): boolean {
  const found = projectFiles.find((file) => file.filePath === filePath);
  if (!found) return isTestFilename(filePath);
  return isTestFileContent(found.filePath, found.source);
}
