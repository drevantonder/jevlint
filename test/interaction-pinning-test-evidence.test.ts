import { readFile } from "node:fs/promises";
import { describe, expect, it } from "vitest";
import { extractCandidates } from "../src/candidates.js";
import { buildInteractionPinningTestEvidence } from "../src/evidence/interaction-pinning-test.js";
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

describe("interaction pinning test evidence", () => {
  it("flags interaction-only assertions on an internal spy", async () => {
    const projectFiles = await project("interaction-positive", [
      "test/calc.test.ts",
      "src/calc.ts",
    ]);
    const owner = projectFiles[0];
    expect(owner).toBeDefined();
    if (!owner) return;
    const candidate = candidateFor(owner, "toHaveBeenCalledTimes");
    expect(candidate).toBeDefined();
    if (!candidate) return;

    expect(buildInteractionPinningTestEvidence(candidate, projectFiles)).toMatchObject({
      interactionAssertions: [
        expect.stringContaining("toHaveBeenCalledTimes(1)"),
        expect.stringContaining("toHaveBeenCalledWith(3)"),
      ],
      outcomeAssertions: [],
      spyTargets: [{ target: "math", imported: true }],
    });
  });

  it("keeps outcome assertions visible", async () => {
    const projectFiles = await project("interaction-negative", [
      "test/calc.test.ts",
      "src/calc.ts",
    ]);
    const owner = projectFiles[0];
    expect(owner).toBeDefined();
    if (!owner) return;
    const candidate = candidateFor(owner, "toBe(3)");
    expect(candidate).toBeDefined();
    if (!candidate) return;

    expect(buildInteractionPinningTestEvidence(candidate, projectFiles)).toMatchObject({
      interactionAssertions: [],
      outcomeAssertions: [expect.stringContaining("toBe(3)")],
    });
  });

  it("abstains when the test states no assertions", async () => {
    const owner: ProjectFile = {
      filePath: "test/plain.test.ts",
      source: "import { it } from \"vitest\";\nimport { total } from \"../src/calc.js\";\n\nit(\"sums rows\", () => {\n  total([1, 2]);\n});\n",
    };
    const candidate = candidateFor(owner, "total([1, 2])");
    expect(candidate).toBeDefined();
    if (!candidate) return;

    expect(buildInteractionPinningTestEvidence(candidate, [owner])).toBeUndefined();
  });
});
