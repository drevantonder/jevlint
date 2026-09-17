import { readFile } from "node:fs/promises";
import { describe, expect, it } from "vitest";
import { extractCandidates } from "../src/candidates.js";
import { buildQuarantinedTestCoverageEvidence } from "../src/evidence/quarantined-test-coverage.js";
import type { ProjectFile } from "../src/types.js";

const repositories = new URL("./fixtures/repositories/", import.meta.url);

async function project(name: string, paths: string[]): Promise<ProjectFile[]> {
  return Promise.all(paths.map(async (filePath) => ({
    filePath,
    source: await readFile(new URL(`${name}/${filePath}`, repositories), "utf8"),
  })));
}

function candidateFor(owner: ProjectFile, needle: string) {
  return extractCandidates(owner.filePath, owner.source)
    .filter(({ kind, source }) => kind === "function" && source.includes(needle))
    .sort((left, right) => left.source.length - right.source.length)[0];
}

describe("quarantined test coverage evidence", () => {
  it("flags a skipped test with no other coverage", async () => {
    const projectFiles = await project("quarantine-positive", [
      "test/calc.test.ts",
      "src/calc.ts",
    ]);
    const owner = projectFiles[0];
    expect(owner).toBeDefined();
    if (!owner) return;
    const candidate = candidateFor(owner, "toBe(3)");
    expect(candidate).toBeDefined();
    if (!candidate) return;

    expect(buildQuarantinedTestCoverageEvidence(candidate, projectFiles)).toMatchObject({
      function: { title: "sums rows", modifier: expect.stringContaining("skip") },
      disabled: { assertionCount: 1, subjectSymbols: ["total"] },
      coverage: { otherTestReferences: [], otherTestReferenceCount: 0 },
    });
  });

  it("records the active test still covering the subject", async () => {
    const projectFiles = await project("quarantine-negative", [
      "test/calc.test.ts",
      "test/totals.test.ts",
      "src/calc.ts",
    ]);
    const owner = projectFiles[0];
    expect(owner).toBeDefined();
    if (!owner) return;
    const candidate = candidateFor(owner, "toBe(1)");
    expect(candidate).toBeDefined();
    if (!candidate) return;

    expect(buildQuarantinedTestCoverageEvidence(candidate, projectFiles)).toMatchObject({
      function: { modifier: expect.stringContaining("skip") },
      coverage: {
        otherTestReferences: ["test/totals.test.ts"],
        otherTestReferenceCount: 1,
      },
    });
  });

  it("abstains when the test is active", async () => {
    const owner: ProjectFile = {
      filePath: "test/plain.test.ts",
      source: "import { it, expect } from \"vitest\";\nimport { total } from \"../src/calc.js\";\n\nit(\"sums rows\", () => {\n  expect(total([1, 2])).toBe(3);\n});\n",
    };
    const candidate = candidateFor(owner, "toBe(3)");
    expect(candidate).toBeDefined();
    if (!candidate) return;

    expect(buildQuarantinedTestCoverageEvidence(candidate, [owner])).toBeUndefined();
  });
});
