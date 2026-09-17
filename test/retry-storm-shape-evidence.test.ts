import { readFile } from "node:fs/promises";
import { describe, expect, it } from "vitest";
import { extractCandidates } from "../src/candidates.js";
import { buildRetryStormEvidence } from "../src/evidence/retry-storm-shape.js";
import type { ProjectFile } from "../src/types.js";

const repositories = new URL("./fixtures/repositories/", import.meta.url);

async function project(name: string, paths: string[]): Promise<ProjectFile[]> {
  return Promise.all(paths.map(async (filePath) => ({
    filePath,
    source: await readFile(new URL(`${name}/${filePath}`, repositories), "utf8"),
  })));
}

describe("retry storm shape evidence", () => {
  it("aggregates sibling retry sites around one shared dependency", async () => {
    const projectFiles = await project("retry-storm-shape-positive", [
      "src/charge-a.ts",
      "src/charge-b.ts",
      "src/payment-gateway.ts",
      "src/caller.ts",
    ]);
    const owner = projectFiles[0];
    expect(owner).toBeDefined();
    if (!owner) return;
    const candidate = extractCandidates(owner.filePath, owner.source)
      .find(({ source }) => source.includes("function chargeWithRetry"));
    expect(candidate).toBeDefined();
    if (!candidate) return;

    const evidence = buildRetryStormEvidence(candidate, projectFiles);

    expect(evidence).toMatchObject({
      function: { name: "chargeWithRetry", exported: true },
      ownRetry: {
        source: expect.stringContaining("paymentGateway.charge"),
        timing: "fixed-delay",
        hasAttemptBudget: false,
      },
      sharedDependency: {
        name: "paymentGateway",
        importedFrom: "./payment-gateway.js",
        ownership: "project-module",
      },
      siblingRetrySites: [
        expect.objectContaining({
          filePath: "src/charge-b.ts",
          function: "rebillWithRetry",
          call: expect.stringContaining("paymentGateway.charge"),
          timing: "none",
        }),
      ],
      repository: {
        callers: [expect.objectContaining({ filePath: "src/caller.ts" })],
      },
    });
  });

  it("abstains when no sibling retries the shared dependency", async () => {
    const projectFiles = await project("retry-storm-shape-negative", [
      "src/charge.ts",
      "src/payment-gateway.ts",
      "src/receipt.ts",
    ]);
    const owner = projectFiles[0];
    expect(owner).toBeDefined();
    if (!owner) return;
    const candidate = extractCandidates(owner.filePath, owner.source)
      .find(({ source }) => source.includes("function chargeWithPolicy"));
    expect(candidate).toBeDefined();
    if (!candidate) return;

    expect(buildRetryStormEvidence(candidate, projectFiles)).toBeUndefined();
  });
});
