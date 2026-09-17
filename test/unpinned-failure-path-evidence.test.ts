import { readFile } from "node:fs/promises";
import { describe, expect, it } from "vitest";
import { extractCandidates } from "../src/candidates.js";
import { buildUnpinnedFailurePathEvidence } from "../src/evidence/unpinned-failure-path.js";
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

describe("unpinned failure path evidence", () => {
  it("surfaces the catch mapping with zero test references", async () => {
    const projectFiles = await project("failure-positive", [
      "src/charge.ts",
      "src/gateway.ts",
      "test/other.test.ts",
    ]);
    const owner = projectFiles[0];
    expect(owner).toBeDefined();
    if (!owner) return;
    const candidate = candidateFor(owner, "chargeCard");
    expect(candidate).toBeDefined();
    if (!candidate) return;

    expect(buildUnpinnedFailurePathEvidence(candidate, projectFiles)).toMatchObject({
      function: { name: "chargeCard" },
      failurePaths: [
        { kind: "catch", recovery: "maps-to-domain-error" },
      ],
      pinning: { testReferences: [], testReferenceCount: 0 },
    });
  });

  it("records the test reference pinning the mapping", async () => {
    const projectFiles = await project("failure-negative", [
      "src/charge.ts",
      "src/gateway.ts",
      "test/charge.test.ts",
    ]);
    const owner = projectFiles[0];
    expect(owner).toBeDefined();
    if (!owner) return;
    const candidate = candidateFor(owner, "chargeCard");
    expect(candidate).toBeDefined();
    if (!candidate) return;

    expect(buildUnpinnedFailurePathEvidence(candidate, projectFiles)).toMatchObject({
      function: { name: "chargeCard" },
      failurePaths: [
        { kind: "catch", recovery: "maps-to-domain-error" },
      ],
      pinning: {
        testReferences: ["test/charge.test.ts"],
        testReferenceCount: 1,
      },
    });
  });

  it("abstains when the function has no failure path", async () => {
    const owner: ProjectFile = {
      filePath: "src/calc.ts",
      source: "export function total(rows: number[]): number {\n  return rows.reduce((sum, row) => sum + row, 0);\n}\n",
    };
    const candidate = candidateFor(owner, "total");
    expect(candidate).toBeDefined();
    if (!candidate) return;

    expect(buildUnpinnedFailurePathEvidence(candidate, [owner])).toBeUndefined();
  });
});
