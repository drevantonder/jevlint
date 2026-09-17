import { readFile } from "node:fs/promises";
import { describe, expect, it } from "vitest";
import { extractCandidates } from "../src/candidates.js";
import { buildSwallowedErrorEvidence } from "../src/evidence/swallowed-error.js";
import type { ProjectFile } from "../src/types.js";

const repositories = new URL("./fixtures/repositories/", import.meta.url);

async function project(name: string, paths: string[]): Promise<ProjectFile[]> {
  return Promise.all(paths.map(async (filePath) => ({
    filePath,
    source: await readFile(new URL(`${name}/${filePath}`, repositories), "utf8"),
  })));
}

describe("swallowed error evidence", () => {
  it("connects each catch outcome to continuation, imports, and callers", async () => {
    const projectFiles = await project("swallowed-error-positive", [
      "src/publish-invoice.ts",
      "src/services.ts",
      "src/billing.ts",
    ]);
    const owner = projectFiles[0];
    expect(owner).toBeDefined();
    if (!owner) return;
    const candidate = extractCandidates(owner.filePath, owner.source)
      .find(({ source }) => source.includes("function publishInvoice"));
    expect(candidate).toBeDefined();
    if (!candidate) return;

    const evidence = buildSwallowedErrorEvidence(candidate, projectFiles);

    expect(evidence).toMatchObject({
      function: {
        name: "publishInvoice",
        exported: true,
        source: expect.stringContaining("status: \"published\""),
      },
      handlers: [{
        caught: "error",
        usesCaughtError: true,
        tryBlock: expect.stringContaining("invoiceEvents.publish"),
        catchBody: expect.stringContaining("logger.error"),
        throws: [],
        returns: [],
        calls: [expect.stringContaining("logger.error")],
        continuationAfterTry: expect.stringContaining("markPublished"),
      }],
      repository: {
        callers: [expect.objectContaining({
          filePath: "src/billing.ts",
          call: "publishInvoice(invoiceId)",
        })],
        relatedModules: [expect.objectContaining({
          filePath: "src/services.ts",
          source: expect.stringContaining("invoiceEvents"),
        })],
      },
    });
  });

  it("keeps explicit propagation visible to the semantic judgment", async () => {
    const projectFiles = await project("swallowed-error-negative", [
      "src/store-receipt.ts",
      "src/receipt-store.ts",
      "src/checkout.ts",
    ]);
    const owner = projectFiles[0];
    expect(owner).toBeDefined();
    if (!owner) return;
    const candidate = extractCandidates(owner.filePath, owner.source)[0];
    expect(candidate).toBeDefined();
    if (!candidate) return;

    expect(buildSwallowedErrorEvidence(candidate, projectFiles)).toMatchObject({
      handlers: [{
        throws: [expect.stringContaining("throw new Error")],
        returns: [],
      }],
    });
  });

  it("does not assign a nested function's catch to its enclosing function", () => {
    const source = `
      export async function outer() {
        const task = async () => {
          try { await send(); } catch (error) { logger.warn(error); }
        };
        return task();
      }
    `;
    const candidates = extractCandidates("src/outer.ts", source);
    const outer = candidates.find(({ source: candidateSource }) =>
      candidateSource.includes("function outer"));
    const task = candidates.find(({ source: candidateSource }) =>
      candidateSource.startsWith("async ()"));
    expect(outer).toBeDefined();
    expect(task).toBeDefined();
    if (!outer || !task) return;

    const projectFiles = [{ filePath: "src/outer.ts", source }];
    expect(buildSwallowedErrorEvidence(outer, projectFiles)).toBeUndefined();
    expect(buildSwallowedErrorEvidence(task, projectFiles)).toMatchObject({
      handlers: [{ caught: "error" }],
    });
  });

  it("abstains when a function has no catch handler", () => {
    const source = "export async function load() { return await fetchValue(); }";
    const candidate = extractCandidates("src/load.ts", source)[0];
    expect(candidate).toBeDefined();
    if (!candidate) return;

    expect(buildSwallowedErrorEvidence(candidate, [{ filePath: "src/load.ts", source }]))
      .toBeUndefined();
  });
});
