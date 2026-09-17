import { readFile } from "node:fs/promises";
import { describe, expect, it } from "vitest";
import { extractCandidates } from "../src/candidates.js";
import { buildIncidentalSnapshotEvidence } from "../src/evidence/incidental-snapshot.js";
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

describe("incidental snapshot evidence", () => {
  it("flags a full-tree snapshot with no other assertions", async () => {
    const projectFiles = await project("snapshot-positive", [
      "test/page.test.ts",
      "src/page.ts",
    ]);
    const owner = projectFiles[0];
    expect(owner).toBeDefined();
    if (!owner) return;
    const candidate = candidateFor(owner, "toMatchInlineSnapshot");
    expect(candidate).toBeDefined();
    if (!candidate) return;

    expect(buildIncidentalSnapshotEvidence(candidate, projectFiles)).toMatchObject({
      snapshots: [{ assertion: expect.stringContaining("toMatchInlineSnapshot") }],
      outcomeAssertionCount: 0,
      subject: { importedSymbols: ["renderPage"] },
    });
  });

  it("keeps the narrowing outcome assertion visible", async () => {
    const projectFiles = await project("snapshot-negative", [
      "test/order.test.ts",
      "src/order.ts",
    ]);
    const owner = projectFiles[0];
    expect(owner).toBeDefined();
    if (!owner) return;
    const candidate = candidateFor(owner, "toMatchInlineSnapshot");
    expect(candidate).toBeDefined();
    if (!candidate) return;

    expect(buildIncidentalSnapshotEvidence(candidate, projectFiles)).toMatchObject({
      snapshots: [{ assertion: expect.stringContaining("toMatchInlineSnapshot") }],
      outcomeAssertionCount: 1,
      outcomeAssertions: [expect.stringContaining('toBe("v2")')],
    });
  });

  it("abstains when the test states no snapshot", async () => {
    const owner: ProjectFile = {
      filePath: "test/plain.test.ts",
      source: "import { it, expect } from \"vitest\";\nimport { total } from \"../src/calc.js\";\n\nit(\"sums rows\", () => {\n  expect(total([1, 2])).toBe(3);\n});\n",
    };
    const candidate = candidateFor(owner, "toBe(3)");
    expect(candidate).toBeDefined();
    if (!candidate) return;

    expect(buildIncidentalSnapshotEvidence(candidate, [owner])).toBeUndefined();
  });
});
