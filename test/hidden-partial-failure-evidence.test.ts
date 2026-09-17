import { readFile } from "node:fs/promises";
import { describe, expect, it } from "vitest";
import { extractCandidates } from "../src/candidates.js";
import { buildHiddenPartialFailureEvidence } from "../src/evidence/hidden-partial-failure.js";
import type { ProjectFile } from "../src/types.js";

const repositories = new URL("./fixtures/repositories/", import.meta.url);

async function project(name: string, paths: string[]): Promise<ProjectFile[]> {
  return Promise.all(paths.map(async (filePath) => ({
    filePath,
    source: await readFile(new URL(`${name}/${filePath}`, repositories), "utf8"),
  })));
}

describe("hidden partial failure evidence", () => {
  it("connects settled batch outcomes to result handling and caller assumptions", async () => {
    const projectFiles = await project("hidden-partial-failure-positive", [
      "src/send-campaign.ts",
      "src/mailer.ts",
      "src/campaign-job.ts",
    ]);
    const owner = projectFiles[0];
    expect(owner).toBeDefined();
    if (!owner) return;
    const candidate = extractCandidates(owner.filePath, owner.source)
      .find(({ source }) => source.includes("function sendCampaign"));
    expect(candidate).toBeDefined();
    if (!candidate) return;

    const evidence = buildHiddenPartialFailureEvidence(candidate, projectFiles);

    expect(evidence).toMatchObject({
      function: { name: "sendCampaign", exported: true },
      batchMechanisms: [{
        kind: "all-settled",
        resultBinding: "outcomes",
        source: expect.stringContaining("Promise.allSettled"),
        continuation: expect.stringContaining("outcome.status === \"fulfilled\""),
        statusLiterals: ["fulfilled"],
        catches: [],
      }],
      functionOutcomes: {
        returns: [expect.stringContaining("return outcomes")],
        throws: [],
      },
      repository: {
        callers: [expect.objectContaining({
          filePath: "src/campaign-job.ts",
          call: "sendCampaign(recipientIds)",
        })],
        callerModules: [expect.objectContaining({
          source: expect.stringContaining("status: \"complete\""),
        })],
        relatedModules: [expect.objectContaining({ filePath: "src/mailer.ts" })],
      },
    });
  });

  it("shows when both successful and failed outcomes remain explicit", async () => {
    const projectFiles = await project("hidden-partial-failure-negative", [
      "src/send-campaign.ts",
      "src/mailer.ts",
      "src/campaign-job.ts",
    ]);
    const owner = projectFiles[0];
    expect(owner).toBeDefined();
    if (!owner) return;
    const candidate = extractCandidates(owner.filePath, owner.source)
      .find(({ source }) => source.includes("function sendCampaign"));
    expect(candidate).toBeDefined();
    if (!candidate) return;

    expect(buildHiddenPartialFailureEvidence(candidate, projectFiles)).toMatchObject({
      batchMechanisms: [{
        statusLiterals: ["fulfilled", "rejected"],
        continuation: expect.stringContaining("failed:"),
      }],
      repository: {
        callerModules: [expect.objectContaining({ source: expect.stringContaining("partial") })],
      },
    });
  });

  it("extracts per-item catch-and-continue batch handling", async () => {
    const projectFiles = await project("hidden-partial-failure-ambiguous", [
      "src/refresh-search-hints.ts",
      "src/search-hints.ts",
      "src/import-job.ts",
    ]);
    const owner = projectFiles[0];
    expect(owner).toBeDefined();
    if (!owner) return;
    const candidate = extractCandidates(owner.filePath, owner.source)
      .find(({ source }) => source.includes("function refreshSearchHints"));
    expect(candidate).toBeDefined();
    if (!candidate) return;

    expect(buildHiddenPartialFailureEvidence(candidate, projectFiles)).toMatchObject({
      batchMechanisms: [{
        kind: "per-item-catch",
        iteration: "const productId of productIds",
        catches: [{
          caught: "error",
          body: expect.stringContaining("logger.warn"),
          throws: [],
        }],
      }],
    });
  });

  it("abstains from fail-fast Promise.all", () => {
    const source = `
      export async function loadAll(ids: string[]) {
        return Promise.all(ids.map((id) => load(id)));
      }
    `;
    const candidate = extractCandidates("src/load-all.ts", source)
      .find(({ source: candidateSource }) => candidateSource.includes("function loadAll"));
    expect(candidate).toBeDefined();
    if (!candidate) return;

    expect(buildHiddenPartialFailureEvidence(
      candidate,
      [{ filePath: "src/load-all.ts", source }],
    )).toBeUndefined();
  });
});
