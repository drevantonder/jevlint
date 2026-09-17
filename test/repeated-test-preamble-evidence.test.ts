import { readFile } from "node:fs/promises";
import { describe, expect, it } from "vitest";
import { buildRepeatedTestPreambleEvidence } from "../src/evidence/repeated-test-preamble.js";
import { extractCandidates } from "../src/candidates.js";
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

describe("repeated test preamble evidence", () => {
  it("flags a shared setup beside an adopted factory", async () => {
    const projectFiles = await project("preamble-positive", ["test/users.test.ts"]);
    const owner = projectFiles[0];
    expect(owner).toBeDefined();
    if (!owner) return;
    const candidate = candidateFor(owner, "acme:ann");
    expect(candidate).toBeDefined();
    if (!candidate) return;

    const evidence = buildRepeatedTestPreambleEvidence(candidate, projectFiles);
    expect(evidence).toMatchObject({
      repetitions: [{ sibling: expect.stringContaining("signs") }],
      sharedHelpers: {
        beforeEach: false,
        factories: [{ name: "makeUser", calledByCandidate: false, calledBySiblings: 1 }],
      },
    });
    expect(evidence?.setup.statements.length).toBeGreaterThan(0);
  });

  it("leaves per-test setups alone", async () => {
    const projectFiles = await project("preamble-negative", ["test/users.test.ts"]);
    const owner = projectFiles[0];
    expect(owner).toBeDefined();
    if (!owner) return;
    const candidate = candidateFor(owner, "toBe(\"ann\")");
    expect(candidate).toBeDefined();
    if (!candidate) return;

    expect(buildRepeatedTestPreambleEvidence(candidate, projectFiles)).toMatchObject({
      repetitions: [],
    });
  });

  it("abstains outside test files", async () => {
    const owner: ProjectFile = {
      filePath: "src/plain.ts",
      source: "export function double(value: number): number {\n  return value * 2;\n}\n",
    };
    const candidate = candidateFor(owner, "double");
    expect(candidate).toBeDefined();
    if (!candidate) return;

    expect(buildRepeatedTestPreambleEvidence(candidate, [owner])).toBeUndefined();
  });
});
