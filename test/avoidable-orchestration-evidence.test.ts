import { readFile } from "node:fs/promises";
import { describe, expect, it } from "vitest";
import { extractCandidates } from "../src/candidates.js";
import { buildAvoidableOrchestrationEvidence } from "../src/evidence/avoidable-orchestration.js";
import type { ProjectFile } from "../src/types.js";

const root = new URL("./fixtures/repositories/avoidable-orchestration-required/", import.meta.url);

async function load(filePath: string): Promise<ProjectFile> {
  return { filePath, source: await readFile(new URL(filePath, root), "utf8") };
}

describe("avoidable orchestration evidence", () => {
  it("extracts sequencing and syntactic data dependencies", async () => {
    const projectFiles = await Promise.all(["src/place-order.ts", "src/checkout.ts"].map(load));
    const owner = projectFiles[0];
    expect(owner).toBeDefined();
    if (!owner) return;
    const candidate = extractCandidates(owner.filePath, owner.source)[0];
    expect(candidate).toBeDefined();
    if (!candidate) return;

    const evidence = buildAvoidableOrchestrationEvidence(candidate, projectFiles);

    expect(evidence).toMatchObject({
      function: { name: "placeOrder" },
      awaitedSteps: [
        { binding: "reservation", expression: "reserveInventory(order.items)", dependsOn: [] },
        { binding: "payment", expression: "chargePayment(order.customerId, reservation.total)", dependsOn: ["reservation"] },
        { binding: "confirmation", expression: "confirmOrder(reservation.id, payment.id)", dependsOn: ["reservation", "payment"] },
      ],
      callers: [expect.objectContaining({ filePath: "src/checkout.ts" })],
    });
  });

  it("abstains when there is only one awaited step", () => {
    const source = "export async function load(id: string) { return await fetchUser(id); }";
    const candidate = extractCandidates("src/load.ts", source)[0];
    expect(candidate).toBeDefined();
    if (!candidate) return;
    expect(buildAvoidableOrchestrationEvidence(candidate, [{ filePath: "src/load.ts", source }]))
      .toBeUndefined();
  });
});
