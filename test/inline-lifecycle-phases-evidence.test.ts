import { describe, expect, it } from "vitest";
import { extractCandidates } from "../src/candidates.js";
import { buildInlineLifecyclePhasesEvidence } from "../src/evidence/inline-lifecycle-phases.js";
import type { ProjectFile } from "../src/types.js";

const smellySource = `import { pool } from "./db.js";

export async function confirmOrders(raw: string): Promise<string> {
  const rows = raw.split("\\n");
  const orders = rows.map((row) => row.split(","));
  for (const order of orders) {
    await pool.query("INSERT INTO orders VALUES ($1)", [order[0]]);
  }
  const body = orders.map((order) => "<li>" + order[0] + "</li>").join("");
  return "<ul>" + body + "</ul>";
}
`;

const sandwichSource = `import { priceOrder } from "./pricing.js";

export function handleCheckout(body: { items: number[] }): string {
  const { items } = body;
  const total = priceOrder(items);
  return JSON.stringify({ total });
}
`;

const singlePhaseSource = `export function total(items: number[]): number {
  return items.reduce((sum, item) => sum + item, 0);
}
`;

function candidateFor(source: string, filePath: string) {
  return extractCandidates(filePath, source).find(({ kind }) => kind === "function");
}

describe("inline lifecycle phases evidence", () => {
  it("extracts inline parse, compute, effect, and present regions", () => {
    const files: ProjectFile[] = [{ filePath: "src/orders.ts", source: smellySource }];
    const candidate = candidateFor(smellySource, "src/orders.ts");
    expect(candidate).toBeDefined();
    if (!candidate) return;

    const evidence = buildInlineLifecyclePhasesEvidence(candidate, files);

    expect(evidence).toMatchObject({
      function: { name: "confirmOrders", filePath: "src/orders.ts" },
      phases: ["effect", "present", "parse", "compute"],
      importSources: ["./db.js"],
    });
    expect(evidence?.regions.length).toBeGreaterThanOrEqual(4);
    expect(evidence?.sharedBindings).toEqual(expect.arrayContaining(["rows", "orders"]));
    expect(evidence?.collaborators).toEqual([
      expect.objectContaining({ phase: "effect", importedFrom: "./db.js" }),
    ]);
    expect(evidence?.phaseHelpers).toEqual([]);
  });

  it("surfaces the use-case collaborator seam in a boundary sandwich", () => {
    const files: ProjectFile[] = [{ filePath: "src/checkout.ts", source: sandwichSource }];
    const candidate = candidateFor(sandwichSource, "src/checkout.ts");
    expect(candidate).toBeDefined();
    if (!candidate) return;

    const evidence = buildInlineLifecyclePhasesEvidence(candidate, files);

    expect(evidence?.phases).toEqual(expect.arrayContaining(["parse", "compute", "present"]));
    expect(evidence?.collaborators).toEqual([
      expect.objectContaining({ phase: "compute", importedFrom: "./pricing.js" }),
    ]);
  });

  it("abstains when the body covers a single phase", () => {
    const files: ProjectFile[] = [{ filePath: "src/total.ts", source: singlePhaseSource }];
    const candidate = candidateFor(singlePhaseSource, "src/total.ts");
    expect(candidate).toBeDefined();
    if (!candidate) return;

    expect(buildInlineLifecyclePhasesEvidence(candidate, files)).toBeUndefined();
  });
});
