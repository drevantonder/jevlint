import { readFile } from "node:fs/promises";
import { describe, expect, it } from "vitest";
import { extractCandidates } from "../src/candidates.js";
import { buildUnboundedParallelFanoutEvidence } from "../src/evidence/unbounded-parallel-fanout.js";
import type { ProjectFile } from "../src/types.js";

const repositories = new URL("./fixtures/repositories/", import.meta.url);

async function project(name: string, paths: string[]): Promise<ProjectFile[]> {
  return Promise.all(paths.map(async (filePath) => ({
    filePath,
    source: await readFile(new URL(`${name}/${filePath}`, repositories), "utf8"),
  })));
}

describe("unbounded parallel fanout evidence", () => {
  it("extracts fan-out width over caller-supplied input with no limiter", async () => {
    const projectFiles = await project("unbounded-parallel-fanout-positive", [
      "src/notify.ts",
      "src/mailer.ts",
    ]);
    const owner = projectFiles[0];
    expect(owner).toBeDefined();
    if (!owner) return;
    const candidate = extractCandidates(owner.filePath, owner.source)
      .find(({ source }) => source.includes("function notifyAll"));
    expect(candidate).toBeDefined();
    if (!candidate) return;

    const evidence = buildUnboundedParallelFanoutEvidence(candidate, projectFiles);

    expect(evidence).toMatchObject({
      function: { name: "notifyAll", exported: true },
      fanouts: [{
        combinator: "all",
        collection: "users",
        collectionProvenance: "parameter",
        legSource: expect.stringContaining("sendEmail"),
        heavyLeg: true,
      }],
      limiter: { present: false },
    });
  });

  it("abstains when a concurrency limiter bounds the fan-out", async () => {
    const projectFiles = await project("unbounded-parallel-fanout-negative", [
      "src/notify.ts",
      "src/mailer.ts",
    ]);
    const owner = projectFiles[0];
    expect(owner).toBeDefined();
    if (!owner) return;
    const candidate = extractCandidates(owner.filePath, owner.source)
      .find(({ source }) => source.includes("function notifyAll"));
    expect(candidate).toBeDefined();
    if (!candidate) return;

    expect(buildUnboundedParallelFanoutEvidence(candidate, projectFiles)).toBeUndefined();
  });
});
