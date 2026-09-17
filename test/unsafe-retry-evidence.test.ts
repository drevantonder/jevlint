import { readFile } from "node:fs/promises";
import { describe, expect, it } from "vitest";
import { extractCandidates } from "../src/candidates.js";
import { buildUnsafeRetryEvidence } from "../src/evidence/unsafe-retry.js";
import type { ProjectFile } from "../src/types.js";

const repositories = new URL("./fixtures/repositories/", import.meta.url);

async function project(name: string, paths: string[]): Promise<ProjectFile[]> {
  return Promise.all(paths.map(async (filePath) => ({
    filePath,
    source: await readFile(new URL(`${name}/${filePath}`, repositories), "utf8"),
  })));
}

describe("unsafe retry evidence", () => {
  it("extracts retry control, attempted effects, handlers, dependencies, and callers", async () => {
    const projectFiles = await project("unsafe-retry-positive", [
      "src/charge-order.ts",
      "src/payment-gateway.ts",
      "src/checkout.ts",
    ]);
    const owner = projectFiles[0];
    expect(owner).toBeDefined();
    if (!owner) return;
    const candidate = extractCandidates(owner.filePath, owner.source)
      .find(({ source }) => source.includes("function chargeOrder"));
    expect(candidate).toBeDefined();
    if (!candidate) return;

    const evidence = buildUnsafeRetryEvidence(candidate, projectFiles);

    expect(evidence).toMatchObject({
      function: { name: "chargeOrder", exported: true },
      retryMechanisms: [{
        kind: "loop",
        control: expect.stringContaining("attempt < 5"),
        source: expect.stringContaining("paymentGateway.charge"),
        calls: expect.arrayContaining([
          expect.stringContaining("paymentGateway.charge"),
          "sleep(100)",
        ]),
        catches: [{
          caught: null,
          guards: [],
          throws: [],
        }],
        delayCalls: ["sleep(100)"],
        idempotencySignals: [],
      }],
      repository: {
        callers: [expect.objectContaining({ filePath: "src/checkout.ts" })],
        relatedModules: [expect.objectContaining({
          filePath: "src/payment-gateway.ts",
          source: expect.stringContaining("PaymentDeclinedError"),
        })],
      },
    });
  });

  it("surfaces error classification, exhaustion, backoff, and idempotency policy", async () => {
    const projectFiles = await project("unsafe-retry-negative", [
      "src/charge-order.ts",
      "src/payment-gateway.ts",
      "src/checkout.ts",
    ]);
    const owner = projectFiles[0];
    expect(owner).toBeDefined();
    if (!owner) return;
    const candidate = extractCandidates(owner.filePath, owner.source)
      .find(({ source }) => source.includes("function chargeOrder"));
    expect(candidate).toBeDefined();
    if (!candidate) return;

    expect(buildUnsafeRetryEvidence(candidate, projectFiles)).toMatchObject({
      retryMechanisms: [{
        kind: "loop",
        catches: [{
          caught: "error",
          guards: [expect.stringContaining("GatewayUnavailableError")],
          throws: ["throw error;"],
        }],
        delayCalls: [expect.stringContaining("sleep(retryPolicy.backoffMs * attempt)")],
        idempotencySignals: ["idempotencyKey"],
      }],
    });
  });

  it("recognizes a retry helper while leaving its unresolved policy visible", async () => {
    const projectFiles = await project("unsafe-retry-ambiguous", [
      "src/sync-account.ts",
      "src/account-sync.ts",
      "src/job.ts",
    ]);
    const owner = projectFiles[0];
    expect(owner).toBeDefined();
    if (!owner) return;
    const candidate = extractCandidates(owner.filePath, owner.source)
      .find(({ source }) => source.includes("function syncAccount"));
    expect(candidate).toBeDefined();
    if (!candidate) return;

    expect(buildUnsafeRetryEvidence(candidate, projectFiles)).toMatchObject({
      retryMechanisms: [{
        kind: "retry-call",
        control: null,
        source: expect.stringContaining("withRetry"),
      }],
      repository: {
        relatedModules: [expect.objectContaining({ filePath: "src/account-sync.ts" })],
      },
    });
  });

  it("does not mistake per-item batch handling for a retry loop", () => {
    const source = `
      export async function deliverAll(messages: Message[]) {
        for (const message of messages) {
          try { await deliver(message); }
          catch (error) { recordFailure(message, error); }
        }
      }
    `;
    const candidate = extractCandidates("src/deliver.ts", source)[0];
    expect(candidate).toBeDefined();
    if (!candidate) return;

    expect(buildUnsafeRetryEvidence(
      candidate,
      [{ filePath: "src/deliver.ts", source }],
    )).toBeUndefined();
  });
});
