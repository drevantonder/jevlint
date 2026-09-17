import { readFile } from "node:fs/promises";
import { describe, expect, it } from "vitest";
import { extractCandidates } from "../src/candidates.js";
import { buildFlakyOrderAssertionEvidence } from "../src/evidence/flaky-order-assertion.js";
import type { ProjectFile } from "../src/types.js";

const repositories = new URL("./fixtures/repositories/", import.meta.url);

async function project(name: string, paths: string[]): Promise<ProjectFile[]> {
  return Promise.all(paths.map(async (filePath) => ({
    filePath,
    source: await readFile(new URL(`${name}/${filePath}`, repositories), "utf8"),
  })));
}

function testCandidate(owner: ProjectFile, snippet: string) {
  return extractCandidates(owner.filePath, owner.source)
    .filter(({ kind, source }) => kind === "function" && source.includes(snippet))
    .sort((left, right) => left.source.length - right.source.length)[0];
}

describe("flaky order assertion evidence", () => {
  it("flags order assertions over concurrent work with no synchronization", async () => {
    const projectFiles = await project("flaky-order-smelly", ["test/scheduler.test.ts"]);
    const owner = projectFiles[0];
    expect(owner).toBeDefined();
    if (!owner) return;
    const candidate = testCandidate(owner, "logs[0]");
    expect(candidate).toBeDefined();
    if (!candidate) return;

    const evidence = buildFlakyOrderAssertionEvidence(candidate, projectFiles);
    expect(evidence).toMatchObject({
      orderAssertions: expect.arrayContaining([expect.stringContaining("logs[0]")]),
      syncSignals: [],
    });
    expect(evidence?.concurrentUnits.length).toBeGreaterThanOrEqual(2);
    expect(evidence?.concurrentUnits.some((unit) => !unit.synchronized)).toBe(true);
  });

  it("abstains when joined promises are compared as sorted sets", async () => {
    const projectFiles = await project("flaky-order-negative", ["test/scheduler.test.ts"]);
    const owner = projectFiles[0];
    expect(owner).toBeDefined();
    if (!owner) return;
    const candidate = testCandidate(owner, "Promise.all");
    expect(candidate).toBeDefined();
    if (!candidate) return;

    expect(buildFlakyOrderAssertionEvidence(candidate, projectFiles)).toBeUndefined();
  });
});
