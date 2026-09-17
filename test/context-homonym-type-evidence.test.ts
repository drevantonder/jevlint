import { readFile } from "node:fs/promises";
import { describe, expect, it } from "vitest";
import { extractCandidates } from "../src/candidates.js";
import { buildContextHomonymTypeEvidence } from "../src/evidence/context-homonym-type.js";
import { buildRuleEvidence } from "../src/evidence/index.js";
import type { ProjectFile } from "../src/types.js";

const root = new URL("./fixtures/repositories/context-homonym-type-smelly/", import.meta.url);

async function load(filePath: string): Promise<ProjectFile> {
  return { filePath, source: await readFile(new URL(filePath, root), "utf8") };
}

const unique = `export interface Ledger {
  entries: string[];
}
`;

describe("context homonym type evidence", () => {
  it("pairs same-named disjoint types with their shared client", async () => {
    const projectFiles = await Promise.all(
      ["src/billing.ts", "src/shipping.ts", "src/app.ts"].map(load),
    );
    const owner = projectFiles[0];
    expect(owner).toBeDefined();
    if (!owner) return;
    const candidate = extractCandidates(owner.filePath, owner.source)
      .find(({ kind }) => kind === "abstraction");
    expect(candidate).toBeDefined();
    if (!candidate) return;

    const evidence = buildContextHomonymTypeEvidence(candidate, projectFiles);

    expect(evidence?.abstraction).toMatchObject({
      name: "Invoice",
      members: expect.arrayContaining(["number", "total", "dueDate"]),
    });
    expect(evidence?.homonyms).toHaveLength(1);
    expect(evidence?.homonyms[0]).toMatchObject({
      filePath: "src/shipping.ts",
      members: expect.arrayContaining(["trackingId", "carrier", "weightKg"]),
      memberOverlapRatio: 0,
    });
    expect(evidence?.confusion.sharedClients).toContain("src/app.ts");
  });

  it("abstains when the type name is unique across the project", () => {
    const candidate = extractCandidates("src/ledger.ts", unique)
      .find(({ kind }) => kind === "abstraction");
    expect(candidate).toBeDefined();
    if (!candidate) return;

    expect(buildContextHomonymTypeEvidence(
      candidate,
      [{ filePath: "src/ledger.ts", source: unique }],
    )).toBeUndefined();
  });

  it("dispatches through the rule registry", async () => {
    const projectFiles = await Promise.all(
      ["src/billing.ts", "src/shipping.ts", "src/app.ts"].map(load),
    );
    const owner = projectFiles[0];
    expect(owner).toBeDefined();
    if (!owner) return;
    const candidate = extractCandidates(owner.filePath, owner.source)
      .find(({ kind }) => kind === "abstraction");
    expect(candidate).toBeDefined();
    if (!candidate) return;

    const result = buildRuleEvidence("jev/no-context-homonym-type", candidate, projectFiles);

    expect(result.handled).toBe(true);
    expect(result.handled && result.evidence).toBeDefined();
  });
});
