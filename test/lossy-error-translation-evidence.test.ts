import { readFile } from "node:fs/promises";
import { describe, expect, it } from "vitest";
import { extractCandidates } from "../src/candidates.js";
import { buildLossyErrorTranslationEvidence } from "../src/evidence/lossy-error-translation.js";
import type { ProjectFile } from "../src/types.js";

const repositories = new URL("./fixtures/repositories/", import.meta.url);

async function project(name: string, paths: string[]): Promise<ProjectFile[]> {
  return Promise.all(paths.map(async (filePath) => ({
    filePath,
    source: await readFile(new URL(`${name}/${filePath}`, repositories), "utf8"),
  })));
}

describe("lossy error translation evidence", () => {
  it("shows replaced error details, dependency contracts, and caller expectations", async () => {
    const projectFiles = await project("lossy-error-translation-positive", [
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

    const evidence = buildLossyErrorTranslationEvidence(candidate, projectFiles);

    expect(evidence).toMatchObject({
      function: { name: "chargeOrder", exported: true },
      translations: [{
        caught: null,
        throw: "throw new Error(\"Payment failed\");",
        thrownType: "Error",
        kind: "new-error",
        referencesCaughtError: false,
        preservesCaughtErrorAsCause: false,
      }],
      repository: {
        callers: [expect.objectContaining({
          filePath: "src/checkout.ts",
          call: "chargeOrder(orderId, paymentToken)",
        })],
        callerModules: [expect.objectContaining({
          filePath: "src/checkout.ts",
          source: expect.stringContaining("PaymentDeclinedError"),
        })],
        relatedModules: [expect.objectContaining({
          filePath: "src/payment-gateway.ts",
          source: expect.stringContaining("retryAfterMs"),
        })],
      },
    });
  });

  it("records when a replacement structurally retains the caught error as cause", () => {
    const source = `
      export async function save() {
        try { await store(); }
        catch (error) { throw new Error("Store failed", { cause: error }); }
      }
    `;
    const candidate = extractCandidates("src/save.ts", source)[0];
    expect(candidate).toBeDefined();
    if (!candidate) return;

    expect(buildLossyErrorTranslationEvidence(
      candidate,
      [{ filePath: "src/save.ts", source }],
    )).toMatchObject({
      translations: [{
        caught: "error",
        referencesCaughtError: true,
        preservesCaughtErrorAsCause: true,
      }],
    });
  });

  it("keeps a direct rethrow distinct from replacement", () => {
    const source = `
      export async function save() {
        try { await store(); }
        catch (error) { audit(error); throw error; }
      }
    `;
    const candidate = extractCandidates("src/save.ts", source)[0];
    expect(candidate).toBeDefined();
    if (!candidate) return;

    expect(buildLossyErrorTranslationEvidence(
      candidate,
      [{ filePath: "src/save.ts", source }],
    )).toMatchObject({
      translations: [{ kind: "rethrow", thrownType: null }],
    });
  });

  it("abstains when catches do not throw", () => {
    const source = `
      export async function save() {
        try { await store(); }
        catch (error) { return { ok: false, error }; }
      }
    `;
    const candidate = extractCandidates("src/save.ts", source)[0];
    expect(candidate).toBeDefined();
    if (!candidate) return;

    expect(buildLossyErrorTranslationEvidence(
      candidate,
      [{ filePath: "src/save.ts", source }],
    )).toBeUndefined();
  });
});
