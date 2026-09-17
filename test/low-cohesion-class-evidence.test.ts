import { readFile } from "node:fs/promises";
import { describe, expect, it } from "vitest";
import { extractCandidates } from "../src/candidates.js";
import { buildLowCohesionClassEvidence } from "../src/evidence/low-cohesion-class.js";
import type { ProjectFile } from "../src/types.js";

const smellyRoot = new URL("./fixtures/repositories/low-cohesion-class-smelly/", import.meta.url);
const cohesiveRoot = new URL("./fixtures/repositories/low-cohesion-class-cohesive/", import.meta.url);

async function load(root: URL, filePath: string): Promise<ProjectFile> {
  return { filePath, source: await readFile(new URL(filePath, root), "utf8") };
}

async function project(root: URL, paths: string[]): Promise<ProjectFile[]> {
  return Promise.all(paths.map((filePath) => load(root, filePath)));
}

function classCandidate(owner: ProjectFile) {
  const candidate = extractCandidates(owner.filePath, owner.source)
    .find(({ kind }) => kind === "abstraction");
  expect(candidate).toBeDefined();
  return candidate!;
}

describe("low cohesion class evidence", () => {
  it("reports field-disjoint clusters with distinct collaborators and callers", async () => {
    const projectFiles = await project(smellyRoot, [
      "src/order-manager.ts",
      "src/storefront.ts",
      "src/billing.ts",
      "src/fulfilment.ts",
      "src/db.ts",
      "src/ledger.ts",
      "src/mailer.ts",
    ]);
    const owner = projectFiles[0]!;
    const evidence = buildLowCohesionClassEvidence(classCandidate(owner), projectFiles);

    expect(evidence).toMatchObject({
      class: { name: "OrderManager" },
      fields: expect.arrayContaining(["orders", "outstandingCents", "shipmentIds"]),
      clusters: expect.arrayContaining([
        expect.arrayContaining(["addOrder", "orderCount"]),
        expect.arrayContaining(["charge", "outstanding"]),
        expect.arrayContaining(["ship", "shipped"]),
      ]),
    });
    expect(evidence?.clusters).toHaveLength(3);
    expect(evidence?.methods).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          name: "charge",
          fields: ["outstandingCents"],
          importSources: ["./ledger.js"],
        }),
        expect.objectContaining({
          name: "ship",
          fields: ["shipmentIds"],
          importSources: ["./mailer.js"],
        }),
      ]),
    );
    expect(evidence?.methodCallers).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          method: "charge",
          total: 1,
          callers: [expect.objectContaining({ filePath: "src/billing.ts" })],
        }),
      ]),
    );
  });

  it("keeps a coherent class as one cluster", async () => {
    const projectFiles = await project(cohesiveRoot, ["src/shopping-cart.ts"]);
    const owner = projectFiles[0]!;
    const evidence = buildLowCohesionClassEvidence(classCandidate(owner), projectFiles);

    expect(evidence).toMatchObject({
      class: { name: "ShoppingCart" },
      clusters: [["add", "clear", "count", "remove"]],
    });
  });

  it("abstains without a class or with a single method", () => {
    const single = "export class Tiny { only(): number { return 1; } }";
    const candidate = extractCandidates("src/tiny.ts", single)
      .find(({ kind }) => kind === "abstraction");
    expect(candidate).toBeDefined();
    if (!candidate) return;
    expect(buildLowCohesionClassEvidence(candidate, [{ filePath: "src/tiny.ts", source: single }]))
      .toBeUndefined();

    const fn = "export function lonely(): number { return 1; }";
    const fnCandidate = extractCandidates("src/lonely.ts", fn)
      .find(({ kind }) => kind === "function");
    expect(fnCandidate).toBeDefined();
    if (!fnCandidate) return;
    expect(buildLowCohesionClassEvidence(fnCandidate, [{ filePath: "src/lonely.ts", source: fn }]))
      .toBeUndefined();
  });
});
