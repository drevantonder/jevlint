import { readFile } from "node:fs/promises";
import { describe, expect, it } from "vitest";
import { extractCandidates } from "../src/candidates.js";
import { buildAdHocBranchingEvidence } from "../src/evidence/ad-hoc-branching.js";
import type { ProjectFile } from "../src/types.js";

const root = new URL("./fixtures/repositories/ad-hoc-branching-smelly/", import.meta.url);

async function load(filePath: string): Promise<ProjectFile> {
  return { filePath, source: await readFile(new URL(filePath, root), "utf8") };
}

describe("ad-hoc branching evidence", () => {
  it("shows Jev the independent decisions and surrounding usage", async () => {
    const projectFiles = await Promise.all([
      "src/route-order.ts",
      "src/checkout.ts",
    ].map(load));
    const owner = projectFiles[0];
    expect(owner).toBeDefined();
    if (!owner) return;
    const candidate = extractCandidates(owner.filePath, owner.source)[0];
    expect(candidate).toBeDefined();
    if (!candidate) return;

    const evidence = buildAdHocBranchingEvidence(candidate, projectFiles);

    expect(evidence).toMatchObject({
      function: { name: "routeOrder", source: expect.stringContaining("legacyAccount") },
      branches: [
        expect.objectContaining({ condition: "order.region === \"EU\" && order.legacyAccount" }),
        expect.objectContaining({ condition: "order.customerFlags.includes(\"manual-review\")" }),
        expect.objectContaining({ condition: "order.source === \"partner\" && order.total > 1_000" }),
      ],
      callers: [expect.objectContaining({ filePath: "src/checkout.ts", call: "routeOrder(order)" })],
    });
  });

  it("abstains when there is no branching structure to judge", () => {
    const source = "export function route(order: Order) { return order.route; }";
    const candidate = extractCandidates("src/route.ts", source)[0];
    expect(candidate).toBeDefined();
    if (!candidate) return;

    expect(buildAdHocBranchingEvidence(candidate, [{ filePath: "src/route.ts", source }]))
      .toBeUndefined();
  });
});
