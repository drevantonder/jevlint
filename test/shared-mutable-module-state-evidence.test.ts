import { readFile } from "node:fs/promises";
import { describe, expect, it } from "vitest";
import { extractCandidates } from "../src/candidates.js";
import { buildSharedMutableModuleStateEvidence } from "../src/evidence/shared-mutable-module-state.js";
import type { ProjectFile } from "../src/types.js";

const repositories = new URL("./fixtures/repositories/", import.meta.url);

async function project(name: string, paths: string[]): Promise<ProjectFile[]> {
  return Promise.all(paths.map(async (filePath) => ({
    filePath,
    source: await readFile(new URL(`${name}/${filePath}`, repositories), "utf8"),
  })));
}

describe("shared mutable module state evidence", () => {
  it("reports a binding mutated from two exports with its importers and callers", async () => {
    const projectFiles = await project("shared-mutable-positive", [
      "src/batch.ts",
      "src/consumer.ts",
    ]);
    const owner = projectFiles[0];
    expect(owner).toBeDefined();
    if (!owner) return;
    const candidate = extractCandidates(owner.filePath, owner.source)
      .find(({ kind, source }) => kind === "abstraction" && source.includes("type Batch"));
    expect(candidate).toBeDefined();
    if (!candidate) return;

    expect(buildSharedMutableModuleStateEvidence(candidate, projectFiles)).toMatchObject({
      abstraction: { name: "Batch", exported: true },
      sharedBindings: [{
        binding: "currentBatch",
        kind: "let",
        writers: [
          { function: "appendToBatch", excerpts: [expect.stringContaining("push")] },
          { function: "drainBatch", excerpts: [expect.stringContaining("currentBatch = []")] },
        ],
        resetOrInspectExport: expect.stringContaining("resets shared state"),
      }],
      repository: {
        importers: [expect.objectContaining({ filePath: "src/consumer.ts" })],
        callers: expect.arrayContaining([
          expect.objectContaining({ filePath: "src/consumer.ts" }),
        ]),
      },
    });
  });

  it("surfaces readers alongside writers when a reset seam exists", async () => {
    const projectFiles = await project("shared-mutable-ambiguous", ["src/pool.ts"]);
    const owner = projectFiles[0];
    expect(owner).toBeDefined();
    if (!owner) return;
    const candidate = extractCandidates(owner.filePath, owner.source)
      .find(({ kind, source }) => kind === "abstraction" && source.includes("type Pool"));
    expect(candidate).toBeDefined();
    if (!candidate) return;

    expect(buildSharedMutableModuleStateEvidence(candidate, projectFiles)).toMatchObject({
      sharedBindings: [{
        binding: "available",
        writers: expect.arrayContaining([
          expect.objectContaining({ function: "configurePool" }),
          expect.objectContaining({ function: "acquire" }),
        ]),
        readers: ["poolSize"],
        resetOrInspectExport: expect.stringContaining("inspects shared state"),
      }],
    });
  });

  it("abstains when the binding is initialized once at load", async () => {
    const projectFiles = await project("shared-mutable-negative", ["src/config.ts"]);
    const owner = projectFiles[0];
    expect(owner).toBeDefined();
    if (!owner) return;
    const candidate = extractCandidates(owner.filePath, owner.source)
      .find(({ kind, source }) => kind === "abstraction" && source.includes("type Config"));
    expect(candidate).toBeDefined();
    if (!candidate) return;

    expect(buildSharedMutableModuleStateEvidence(candidate, projectFiles)).toBeUndefined();
  });
});
