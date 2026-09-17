import { readFile } from "node:fs/promises";
import { describe, expect, it } from "vitest";
import { extractCandidates } from "../src/candidates.js";
import { buildPrivateInternalsAssertionEvidence } from "../src/evidence/private-internals-assertion.js";
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

describe("private internals assertion evidence", () => {
  it("flags deep imports, any-casts, and underscore reads pinning internals", async () => {
    const projectFiles = await project("private-internals-smelly", [
      "test/store.test.ts",
      "src/index.ts",
      "src/internal/store.ts",
    ]);
    const owner = projectFiles[0];
    expect(owner).toBeDefined();
    if (!owner) return;
    const candidate = testCandidate(owner, "snapshot.count");
    expect(candidate).toBeDefined();
    if (!candidate) return;

    expect(buildPrivateInternalsAssertionEvidence(candidate, projectFiles)).toMatchObject({
      deepImports: expect.arrayContaining([
        expect.objectContaining({ source: "../src/internal/store.js" }),
      ]),
      anyCasts: expect.arrayContaining([expect.stringContaining("as any")]),
      privateAccesses: expect.arrayContaining([expect.stringContaining("_state")]),
      publicEntryAvailable: true,
    });
  });

  it("abstains when the test drives the public entry and asserts outcomes", async () => {
    const projectFiles = await project("private-internals-negative", [
      "test/store.test.ts",
      "src/index.ts",
      "src/internal/store.ts",
    ]);
    const owner = projectFiles[0];
    expect(owner).toBeDefined();
    if (!owner) return;
    const candidate = testCandidate(owner, "increment()");
    expect(candidate).toBeDefined();
    if (!candidate) return;

    expect(buildPrivateInternalsAssertionEvidence(candidate, projectFiles)).toBeUndefined();
  });
});
