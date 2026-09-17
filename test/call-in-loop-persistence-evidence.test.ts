import { readFile } from "node:fs/promises";
import { describe, expect, it } from "vitest";
import { extractCandidates } from "../src/candidates.js";
import { buildCallInLoopPersistenceEvidence } from "../src/evidence/call-in-loop-persistence.js";
import type { ProjectFile } from "../src/types.js";

const repositories = new URL("./fixtures/repositories/", import.meta.url);

async function project(name: string, paths: string[]): Promise<ProjectFile[]> {
  return Promise.all(paths.map(async (filePath) => ({
    filePath,
    source: await readFile(new URL(`${name}/${filePath}`, repositories), "utf8"),
  })));
}

describe("call in loop persistence evidence", () => {
  it("extracts per-item persistence round-trips with resolved ownership", async () => {
    const projectFiles = await project("call-in-loop-persistence-positive", [
      "src/order-service.ts",
      "src/order-repo.ts",
    ]);
    const owner = projectFiles[0];
    expect(owner).toBeDefined();
    if (!owner) return;
    const candidate = extractCandidates(owner.filePath, owner.source)
      .find(({ source }) => source.includes("function saveOrders"));
    expect(candidate).toBeDefined();
    if (!candidate) return;

    const evidence = buildCallInLoopPersistenceEvidence(candidate, projectFiles);

    expect(evidence).toMatchObject({
      function: { name: "saveOrders", exported: true },
      loops: [{
        collection: "items",
        collectionProvenance: "parameter",
        call: expect.stringContaining("orderRepo.save"),
        calleeRoot: "orderRepo",
        importedFrom: "./order-repo.js",
        ownership: "project-module",
        persistenceSignals: expect.arrayContaining([
          expect.stringContaining("order-repo"),
        ]),
        batchEntryPoint: "saveAll",
      }],
    });
  });

  it("abstains when the loop callee has no persistence ownership trail", async () => {
    const projectFiles = await project("call-in-loop-persistence-negative", [
      "src/sum.ts",
    ]);
    const owner = projectFiles[0];
    expect(owner).toBeDefined();
    if (!owner) return;
    const candidate = extractCandidates(owner.filePath, owner.source)
      .find(({ source }) => source.includes("function sumDoubled"));
    expect(candidate).toBeDefined();
    if (!candidate) return;

    expect(buildCallInLoopPersistenceEvidence(candidate, projectFiles)).toBeUndefined();
  });
});
