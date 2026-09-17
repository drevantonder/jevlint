import { readFile } from "node:fs/promises";
import { describe, expect, it } from "vitest";
import { extractCandidates } from "../src/candidates.js";
import { buildAnemicTypeEvidence } from "../src/evidence/anemic-type.js";
import type { ProjectFile } from "../src/types.js";

const root = new URL("./fixtures/repositories/anemic-type-smelly/", import.meta.url);

async function load(filePath: string): Promise<ProjectFile> {
  return { filePath, source: await readFile(new URL(filePath, root), "utf8") };
}

describe("anemic type evidence", () => {
  it("aggregates bare fields with client-side decisions", async () => {
    const projectFiles = await Promise.all([
      "src/order.ts",
      "src/pricing.ts",
      "src/shipping.ts",
    ].map(load));
    const owner = projectFiles[0];
    expect(owner).toBeDefined();
    if (!owner) return;
    const candidate = extractCandidates(owner.filePath, owner.source)
      .find(({ kind }) => kind === "abstraction");
    expect(candidate).toBeDefined();
    if (!candidate) return;

    const evidence = buildAnemicTypeEvidence(candidate, projectFiles);

    expect(evidence).toMatchObject({
      abstraction: {
        name: "Order",
        kind: "class",
        source: expect.stringContaining("class Order"),
      },
      members: {
        fields: expect.arrayContaining([
          expect.objectContaining({ name: "subtotal" }),
          expect.objectContaining({ name: "couponCode", optional: true }),
        ]),
        accessorOnly: true,
      },
      importingModules: ["src/pricing.ts", "src/shipping.ts"],
    });
    expect(evidence?.members.fields).toHaveLength(6);
    expect(evidence?.members.methods.every(({ logic }) => logic !== "logic")).toBe(true);
    expect(evidence?.clients.total).toBeGreaterThanOrEqual(3);
    expect(evidence?.clients.sites.some(({ branches }) => branches)).toBe(true);
  });

  it("marks methods with control flow and calls as logic", async () => {
    const source = await readFile(new URL("src/ledger.ts", root), "utf8");
    const candidate = extractCandidates("src/ledger.ts", source)
      .find(({ kind }) => kind === "abstraction");
    expect(candidate).toBeDefined();
    if (!candidate) return;

    const evidence = buildAnemicTypeEvidence(candidate, [{ filePath: "src/ledger.ts", source }]);

    expect(evidence).toMatchObject({
      abstraction: { name: "Ledger", kind: "class" },
      members: {
        methods: expect.arrayContaining([
          expect.objectContaining({ name: "post", logic: "logic" }),
        ]),
      },
      clients: { total: 0 },
    });
  });

  it("abstains on memberless and non-class declarations", async () => {
    const source = await readFile(new URL("src/empty.ts", root), "utf8");
    const candidates = extractCandidates("src/empty.ts", source);
    expect(candidates).toHaveLength(2);
    for (const candidate of candidates) {
      expect(buildAnemicTypeEvidence(candidate, [{ filePath: "src/empty.ts", source }]))
        .toBeUndefined();
    }
  });
});
