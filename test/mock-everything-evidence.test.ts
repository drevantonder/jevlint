import { readFile } from "node:fs/promises";
import { describe, expect, it } from "vitest";
import { extractCandidates } from "../src/candidates.js";
import { buildMockEverythingEvidence } from "../src/evidence/mock-everything.js";
import type { ProjectFile } from "../src/types.js";

const repositories = new URL("./fixtures/repositories/", import.meta.url);

async function project(name: string, paths: string[]): Promise<ProjectFile[]> {
  return Promise.all(paths.map(async (filePath) => ({
    filePath,
    source: await readFile(new URL(`${name}/${filePath}`, repositories), "utf8"),
  })));
}

describe("mock everything evidence", () => {
  it("flags a test mocking every collaborator with interaction-only assertions", async () => {
    const projectFiles = await project("mock-positive", [
      "test/pipeline.test.ts",
      "src/pipeline.ts",
    ]);
    const owner = projectFiles[0];
    expect(owner).toBeDefined();
    if (!owner) return;
    const candidate = extractCandidates(owner.filePath, owner.source)
      .filter(({ kind, source }) => kind === "function" && source.includes("store(rows)"))
      .sort((left, right) => left.source.length - right.source.length)[0];
    expect(candidate).toBeDefined();
    if (!candidate) return;

    expect(buildMockEverythingEvidence(candidate, projectFiles)).toMatchObject({
      mockOnlyAssertions: true,
      stateAssertions: [],
      boundaryOnly: false,
    });
  });

  it("keeps a single boundary mock with real assertions visible", async () => {
    const projectFiles = await project("mock-negative", [
      "test/report.test.ts",
      "src/report.ts",
      "src/network.ts",
    ]);
    const owner = projectFiles[0];
    expect(owner).toBeDefined();
    if (!owner) return;
    const candidate = extractCandidates(owner.filePath, owner.source)
      .filter(({ kind, source }) => kind === "function" && source.includes("loadTotal()"))
      .sort((left, right) => left.source.length - right.source.length)[0];
    expect(candidate).toBeDefined();
    if (!candidate) return;

    expect(buildMockEverythingEvidence(candidate, projectFiles)).toMatchObject({
      mockOnlyAssertions: false,
      boundaryOnly: true,
      stateAssertions: [expect.stringContaining("loadTotal()")],
    });
  });

  it("abstains when the test uses no doubles", async () => {
    const projectFiles = await project("mock-nomock", [
      "test/report.test.ts",
      "src/report.ts",
    ]);
    const owner = projectFiles[0];
    expect(owner).toBeDefined();
    if (!owner) return;
    const candidate = extractCandidates(owner.filePath, owner.source)
      .filter(({ kind, source }) => kind === "function" && source.includes('total(["a", "b"])'))
      .sort((left, right) => left.source.length - right.source.length)[0];
    expect(candidate).toBeDefined();
    if (!candidate) return;

    expect(buildMockEverythingEvidence(candidate, projectFiles)).toBeUndefined();
  });
});
