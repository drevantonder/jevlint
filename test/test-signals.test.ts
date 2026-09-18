import { describe, expect, it } from "vitest";
import {
  isTestFileContent,
  isTestFilename,
  isTestFrameworkSpecifier,
} from "../src/evidence/test-signals.js";

describe("test filename pre-pass", () => {
  it("matches test and spec segments across module systems", () => {
    expect(isTestFilename("src/helper.test.ts")).toBe(true);
    expect(isTestFilename("test/collect.spec.mjs")).toBe(true);
    expect(isTestFilename("lib/pricing.test.mts")).toBe(true);
    expect(isTestFilename("packages/a/src/order.spec.cts")).toBe(true);
  });

  it("does not match substrings or directory names", () => {
    // Substring traps the old directory/substring gates tripped: contest,
    // latest, and protesting all contain "test" without being tests.
    expect(isTestFilename("lib/contest.ts")).toBe(false);
    expect(isTestFilename("lib/latest.ts")).toBe(false);
    expect(isTestFilename("src/special.ts")).toBe(false);
    expect(isTestFilename("src/aspects.ts")).toBe(false);
    // Directory placement alone is not a signal anymore.
    expect(isTestFilename("test/helpers.ts")).toBe(false);
    expect(isTestFilename("__tests__/helpers.ts")).toBe(false);
    expect(isTestFilename("e2e/checkout.ts")).toBe(false);
  });
});

describe("test framework specifiers", () => {
  it("matches runner roots and subpaths", () => {
    expect(isTestFrameworkSpecifier("vitest")).toBe(true);
    expect(isTestFrameworkSpecifier("vitest/globals")).toBe(true);
    expect(isTestFrameworkSpecifier("@playwright/test")).toBe(true);
    expect(isTestFrameworkSpecifier("node:test")).toBe(true);
    expect(isTestFrameworkSpecifier("bun:test")).toBe(true);
    expect(isTestFrameworkSpecifier("mocha")).toBe(true);
  });

  it("rejects relative paths, libraries, and prod assertion imports", () => {
    expect(isTestFrameworkSpecifier("./helper.js")).toBe(false);
    expect(isTestFrameworkSpecifier("../src/app.js")).toBe(false);
    // node:assert is the documented exclusion: production invariant code
    // imports it, so it must not mark a file as a test.
    expect(isTestFrameworkSpecifier("node:assert")).toBe(false);
    expect(isTestFrameworkSpecifier("assert")).toBe(false);
    expect(isTestFrameworkSpecifier("playwright-core")).toBe(false);
  });
});

describe("test file content signals", () => {
  it("marks runner imports without a filename segment", () => {
    expect(isTestFileContent(
      "helper.verify.ts",
      "import { expect, it } from \"vitest\";\n"
      + "it(\"formats\", () => { expect(1).toBe(1); });\n",
    )).toBe(true);
    expect(isTestFileContent(
      "packages/a/src/order.checks.ts",
      "import { test } from \"node:test\";\n"
      + "test(\"labels\", () => {});\n",
    )).toBe(true);
    expect(isTestFileContent(
      "specs/login.ts",
      "const { test } = require(\"mocha\");\ntest(\"logs in\", () => {});\n",
    )).toBe(true);
  });

  it("marks injected-global usage with no import at all", () => {
    expect(isTestFileContent(
      "e2e/checkout.ts",
      "cy.visit(\"/login\");\ncy.get(\"button\").click();\n",
    )).toBe(true);
    expect(isTestFileContent(
      "specs/price.ts",
      "expect(price(5)).toBe(\"$0.05\");\n",
    )).toBe(true);
    expect(isTestFileContent(
      "deno/checks.ts",
      "Deno.test(\"labels\", () => {});\n",
    )).toBe(true);
  });

  it("requires the title shape for ambiguous it/test calls", () => {
    // A production helper coincidentally named test(), called with values
    // rather than a runner title, stays production.
    expect(isTestFileContent(
      "lib/validate.ts",
      "import { test } from \"./rules.js\";\n"
      + "export function valid(value: string): boolean {\n"
      + "  return test(value);\n"
      + "}\n",
    )).toBe(false);
    expect(isTestFileContent(
      "specs/price.ts",
      "test(\"prices\", () => {});\n",
    )).toBe(true);
  });

  it("does not mark production assertion or helper patterns", () => {
    // Bare assert() with node:assert is the prod-invariant pattern the
    // signal set deliberately excludes.
    expect(isTestFileContent(
      "lib/pricing.ts",
      "import assert from \"node:assert\";\n"
      + "export function price(cents: number): number {\n"
      + "  assert(cents >= 0);\n"
      + "  return cents / 100;\n"
      + "}\n",
    )).toBe(false);
    expect(isTestFileContent(
      "src/server.ts",
      "import express from \"express\";\n"
      + "export function start(): string {\n"
      + "  return express();\n"
      + "}\n",
    )).toBe(false);
  });

  it("falls back to the filename when the source fails to parse", () => {
    expect(isTestFileContent("src/broken.test.ts", "export function (((")).toBe(true);
    expect(isTestFileContent("src/broken.ts", "export function (((")).toBe(false);
  });
});
