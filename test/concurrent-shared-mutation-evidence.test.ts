import { readFile } from "node:fs/promises";
import { describe, expect, it } from "vitest";
import { extractCandidates } from "../src/candidates.js";
import { buildConcurrentSharedMutationEvidence } from "../src/evidence/concurrent-shared-mutation.js";
import type { ProjectFile } from "../src/types.js";

const repositories = new URL("./fixtures/repositories/", import.meta.url);

async function project(name: string, paths: string[]): Promise<ProjectFile[]> {
  return Promise.all(paths.map(async (filePath) => ({
    filePath,
    source: await readFile(new URL(`${name}/${filePath}`, repositories), "utf8"),
  })));
}

describe("concurrent shared mutation evidence", () => {
  it("extracts uncoordinated writes into one closed-over binding from concurrent legs", async () => {
    const projectFiles = await project("concurrent-shared-mutation-positive", [
      "src/collect.ts",
      "src/client.ts",
    ]);
    const owner = projectFiles[0];
    expect(owner).toBeDefined();
    if (!owner) return;
    const candidate = extractCandidates(owner.filePath, owner.source)
      .find(({ source }) => source.includes("function collect"));
    expect(candidate).toBeDefined();
    if (!candidate) return;

    const evidence = buildConcurrentSharedMutationEvidence(candidate, projectFiles);

    expect(evidence).toMatchObject({
      function: { name: "collect", exported: true },
      scheduling: {
        mechanisms: expect.arrayContaining([expect.stringContaining("Promise.all")]),
        legCount: 2,
      },
      bindings: [
        expect.objectContaining({
          name: "results",
          kind: "array",
          declaredIn: "module",
          mutations: expect.arrayContaining([
            expect.objectContaining({ source: expect.stringContaining("results.push") }),
          ]),
        }),
      ],
      coordination: { hasAggregation: false },
    });
    expect(evidence?.bindings[0]?.mutations).toHaveLength(2);
  });

  it("abstains when mutations run sequentially with no concurrent scheduling", async () => {
    const projectFiles = await project("concurrent-shared-mutation-negative", [
      "src/collect.ts",
      "src/client.ts",
    ]);
    const owner = projectFiles[0];
    expect(owner).toBeDefined();
    if (!owner) return;
    const candidate = extractCandidates(owner.filePath, owner.source)
      .find(({ source }) => source.includes("function collectSequential"));
    expect(candidate).toBeDefined();
    if (!candidate) return;

    expect(buildConcurrentSharedMutationEvidence(candidate, projectFiles)).toBeUndefined();
  });
});
