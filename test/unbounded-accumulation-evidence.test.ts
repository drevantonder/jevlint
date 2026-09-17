import { readFile } from "node:fs/promises";
import { describe, expect, it } from "vitest";
import { extractCandidates } from "../src/candidates.js";
import { buildUnboundedAccumulationEvidence } from "../src/evidence/unbounded-accumulation.js";
import type { ProjectFile } from "../src/types.js";

const repositories = new URL("./fixtures/repositories/", import.meta.url);

async function project(name: string, paths: string[]): Promise<ProjectFile[]> {
  return Promise.all(paths.map(async (filePath) => ({
    filePath,
    source: await readFile(new URL(`${name}/${filePath}`, repositories), "utf8"),
  })));
}

describe("unbounded accumulation evidence", () => {
  it("extracts growth into a module-lived container with no eviction", async () => {
    const projectFiles = await project("unbounded-accumulation-positive", [
      "src/seen-urls.ts",
      "src/handler.ts",
    ]);
    const owner = projectFiles[0];
    expect(owner).toBeDefined();
    if (!owner) return;
    const candidate = extractCandidates(owner.filePath, owner.source)
      .find(({ source }) => source.includes("function trackRequest"));
    expect(candidate).toBeDefined();
    if (!candidate) return;

    const evidence = buildUnboundedAccumulationEvidence(candidate, projectFiles);

    expect(evidence).toMatchObject({
      function: { name: "trackRequest", exported: true },
      containers: [{ name: "seenUrls", kind: "map", lifetime: "module" }],
      growths: [{
        container: "seenUrls",
        method: "set",
        source: expect.stringContaining("seenUrls.set"),
      }],
      eviction: {
        hasDelete: false,
        hasClear: false,
        hasTtlOrLru: false,
        hasLengthGuard: false,
      },
      inputKeyed: true,
      repository: {
        callers: [expect.objectContaining({ filePath: "src/handler.ts" })],
      },
    });
  });

  it("abstains when growth stays in request-scoped state", async () => {
    const projectFiles = await project("unbounded-accumulation-negative", [
      "src/build-report.ts",
    ]);
    const owner = projectFiles[0];
    expect(owner).toBeDefined();
    if (!owner) return;
    const candidate = extractCandidates(owner.filePath, owner.source)
      .find(({ source }) => source.includes("function buildReport"));
    expect(candidate).toBeDefined();
    if (!candidate) return;

    expect(buildUnboundedAccumulationEvidence(candidate, projectFiles)).toBeUndefined();
  });
});
