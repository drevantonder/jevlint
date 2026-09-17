import { readFile } from "node:fs/promises";
import { describe, expect, it } from "vitest";
import { extractCandidates } from "../src/candidates.js";
import { buildConvergentTwinTypesEvidence } from "../src/evidence/convergent-twin-types.js";
import type { ProjectFile } from "../src/types.js";

const root = new URL("./fixtures/repositories/convergent-twin-smelly/", import.meta.url);

async function load(filePath: string): Promise<ProjectFile> {
  return { filePath, source: await readFile(new URL(filePath, root), "utf8") };
}

describe("convergent twin types evidence", () => {
  it("pairs the twin shapes, shared fields, and overlapping consumers", async () => {
    const projectFiles = await Promise.all([
      "src/billing.ts",
      "src/reporting.ts",
      "src/dashboard.ts",
    ].map(load));
    const owner = projectFiles.find((file) => file.filePath === "src/billing.ts");
    expect(owner).toBeDefined();
    if (!owner) return;
    const candidate = extractCandidates(owner.filePath, owner.source)
      .find(({ source }) => source.includes("BillingInvoice"));
    expect(candidate).toBeDefined();
    if (!candidate) return;

    const evidence = buildConvergentTwinTypesEvidence(candidate, projectFiles);

    expect(evidence).toMatchObject({
      abstraction: { name: "BillingInvoice" },
      twin: { name: "ReportingInvoice", filePath: "src/reporting.ts" },
      consumers: { sharedImporterFiles: ["src/dashboard.ts"] },
    });
    expect(evidence?.sharedProperties).toHaveLength(8);
    expect(evidence?.propertyJaccard).toBe(1);
  });

  it("abstains for small coincidental shapes with no twin", async () => {
    const distinct = new URL("./fixtures/repositories/convergent-twin-distinct/", import.meta.url);
    const projectFiles = await Promise.all([
      "src/billing.ts",
      "src/reporting.ts",
    ].map(async (filePath): Promise<ProjectFile> => ({
      filePath,
      source: await readFile(new URL(filePath, distinct), "utf8"),
    })));
    const owner = projectFiles[0];
    expect(owner).toBeDefined();
    if (!owner) return;
    const candidate = extractCandidates(owner.filePath, owner.source)
      .find(({ source }) => source.includes("BillingAccount"));
    expect(candidate).toBeDefined();
    if (!candidate) return;

    expect(buildConvergentTwinTypesEvidence(candidate, projectFiles))
      .toBeUndefined();
  });
});
