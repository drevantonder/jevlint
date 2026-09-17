import { readFile } from "node:fs/promises";
import { describe, expect, it } from "vitest";
import { extractCandidates } from "../src/candidates.js";
import { buildGiantTestArrangeEvidence } from "../src/evidence/giant-test-arrange.js";
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

describe("giant test arrange evidence", () => {
  it("inventories inline setup mass before the first assertion", async () => {
    const projectFiles = await project("giant-arrange-smelly", ["test/cart.test.ts"]);
    const owner = projectFiles[0];
    expect(owner).toBeDefined();
    if (!owner) return;
    const candidate = testCandidate(owner, "checkout(cart)");
    expect(candidate).toBeDefined();
    if (!candidate) return;

    const evidence = buildGiantTestArrangeEvidence(candidate, projectFiles);
    expect(evidence).toMatchObject({ assertionCount: 1 });
    expect(evidence?.arrangeStatements).toBeGreaterThan(3);
    expect(evidence?.objectLiteralProps).toBeGreaterThan(10);
    expect(evidence?.largestInlineLiteral).toBeGreaterThan(3);
  });

  it("abstains when the test states its expectation with no arrange phase", async () => {
    const projectFiles = await project("giant-arrange-negative", ["test/math.test.ts"]);
    const owner = projectFiles[0];
    expect(owner).toBeDefined();
    if (!owner) return;
    const candidate = testCandidate(owner, "add(1, 2)");
    expect(candidate).toBeDefined();
    if (!candidate) return;

    expect(buildGiantTestArrangeEvidence(candidate, projectFiles)).toBeUndefined();
  });
});
