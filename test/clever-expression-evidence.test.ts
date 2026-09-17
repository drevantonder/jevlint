import { describe, expect, it } from "vitest";
import { extractCandidates } from "../src/candidates.js";
import { buildCleverExpressionEvidence } from "../src/evidence/clever-expression.js";
import type { ProjectFile } from "../src/types.js";

const assignmentInTest = `export function current(cache: Cache) {
  if (entry = cache.fetch()) {
    return entry;
  }
  return fallback();
}
`;

const chained = `export function reset() {
  let a = 0;
  let b = 0;
  a = b = 1;
  return [a, b];
}
`;

const bitwise = `export function flag(value: number) {
  return value | DEFAULT_FLAG;
}
`;

const plain = `export function ready(enabled: boolean) {
  if (!!enabled) {
    return start();
  }
  return stop();
}
`;

function project(source: string, filePath = "src/flags.ts"): ProjectFile[] {
  return [{ filePath, source }];
}

function candidateFor(source: string, filePath: string, marker: string) {
  const candidate = extractCandidates(filePath, source)
    .find(({ kind, source: text }) => kind === "function" && text.includes(marker));
  expect(candidate).toBeDefined();
  return candidate!;
}

describe("clever expression evidence", () => {
  it("flags assignment inside a test position", () => {
    const filePath = "src/cache.ts";
    const evidence = buildCleverExpressionEvidence(candidateFor(assignmentInTest, filePath, "current"), project(assignmentInTest, filePath));

    expect(evidence).toMatchObject({
      function: { name: "current", exported: true },
    });
    expect(evidence?.findings.map(({ kind }) => kind)).toContain("assignment-in-test");
  });

  it("flags chained assignment", () => {
    const filePath = "src/reset.ts";
    const evidence = buildCleverExpressionEvidence(candidateFor(chained, filePath, "reset"), project(chained, filePath));

    expect(evidence?.findings.map(({ kind }) => kind)).toContain("chained-assignment");
  });

  it("flags bitwise defaults on non-bitwise domains", () => {
    const filePath = "src/flags.ts";
    const evidence = buildCleverExpressionEvidence(candidateFor(bitwise, filePath, "flag"), project(bitwise, filePath));

    expect(evidence?.findings.map(({ kind }) => kind)).toContain("bitwise");
  });

  it("abstains for plain comparisons and conventional coercion", () => {
    const filePath = "src/ready.ts";
    expect(buildCleverExpressionEvidence(candidateFor(plain, filePath, "ready"), project(plain, filePath))).toBeUndefined();
  });

  it("abstains for non-function candidates", () => {
    const filePath = "src/flags.ts";
    const candidate = { ...candidateFor(bitwise, filePath, "flag"), kind: "change" as const };
    expect(buildCleverExpressionEvidence(candidate, project(bitwise, filePath))).toBeUndefined();
  });
});
