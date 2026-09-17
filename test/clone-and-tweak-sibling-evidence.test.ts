import { readFile } from "node:fs/promises";
import { describe, expect, it } from "vitest";
import { extractCandidates } from "../src/candidates.js";
import { buildCloneAndTweakSiblingEvidence } from "../src/evidence/clone-and-tweak-sibling.js";
import type { ProjectFile } from "../src/types.js";

const root = new URL("./fixtures/repositories/clone-and-tweak-smelly/", import.meta.url);

async function load(filePath: string): Promise<ProjectFile> {
  return { filePath, source: await readFile(new URL(filePath, root), "utf8") };
}

describe("clone and tweak sibling evidence", () => {
  it("pairs the clone with its sibling, tweak literals, and both caller lists", async () => {
    const projectFiles = await Promise.all([
      "src/invoices.ts",
      "src/checkout.ts",
    ].map(load));
    const owner = projectFiles[0];
    expect(owner).toBeDefined();
    if (!owner) return;
    const candidate = extractCandidates(owner.filePath, owner.source)
      .find(({ source }) => source.includes("invoiceTotalWithDiscount"));
    expect(candidate).toBeDefined();
    if (!candidate) return;

    const evidence = buildCloneAndTweakSiblingEvidence(candidate, projectFiles);

    expect(evidence).toMatchObject({
      function: {
        name: "invoiceTotalWithDiscount",
        exported: true,
        params: ["items", "taxRate", "discount"],
      },
      sibling: { name: "invoiceTotal", params: ["items", "taxRate"] },
      similarity: { paramDelta: 1 },
      functionCallers: [expect.objectContaining({ filePath: "src/checkout.ts" })],
      siblingCallers: [expect.objectContaining({ filePath: "src/checkout.ts" })],
    });
    expect(evidence?.similarity.tokenJaccard).toBeGreaterThanOrEqual(0.5);
  });

  it("abstains when no same-module sibling shares the shape", async () => {
    const filePath = "src/invoices.ts";
    const source = await readFile(
      new URL(
        "./fixtures/repositories/clone-and-tweak-cohesive/src/invoices.ts",
        import.meta.url,
      ),
      "utf8",
    );
    const candidate = extractCandidates(filePath, source)
      .find(({ source }) => source.includes("overdueReminder"));
    expect(candidate).toBeDefined();
    if (!candidate) return;

    expect(buildCloneAndTweakSiblingEvidence(candidate, [{ filePath, source }]))
      .toBeUndefined();
  });

  it("abstains for a lone function with no siblings", () => {
    const source = "export function total(items: number[]) { return items.reduce((a, b) => a + b, 0); }";
    const candidate = extractCandidates("src/total.ts", source)[0];
    expect(candidate).toBeDefined();
    if (!candidate) return;

    expect(buildCloneAndTweakSiblingEvidence(candidate, [{ filePath: "src/total.ts", source }]))
      .toBeUndefined();
  });
});
