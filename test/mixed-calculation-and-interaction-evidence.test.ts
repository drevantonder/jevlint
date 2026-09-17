import { describe, expect, it } from "vitest";
import { extractCandidates } from "../src/candidates.js";
import { buildMixedCalculationAndInteractionEvidence } from "../src/evidence/mixed-calculation-and-interaction.js";
import type { ProjectFile } from "../src/types.js";

function changedFunction(ownerSource: string) {
  const projectFiles: ProjectFile[] = [{ filePath: "src/pricing.ts", source: ownerSource }];
  const candidate = extractCandidates("src/pricing.ts", ownerSource)
    .find(({ kind }) => kind === "function");
  expect(candidate).toBeDefined();
  if (!candidate) throw new Error("Fixture has no function candidate.");
  expect(candidate.kind).toBe("function");
  return { candidate, projectFiles };
}

describe("mixed calculation and interaction evidence", () => {
  it("reports a file read embedded in a pricing formula", () => {
    const { candidate, projectFiles } = changedFunction(
      "import fs from \"node:fs\";\n"
      + "export function total(items: Array<{ price: number }>): number {\n"
      + "  const rate = JSON.parse(fs.readFileSync(\"./rate.json\", \"utf8\")).rate;\n"
      + "  return items.reduce((sum, item) => sum + item.price * rate, 0);\n"
      + "}\n",
    );

    const evidence = buildMixedCalculationAndInteractionEvidence(candidate, projectFiles);

    expect(evidence).toMatchObject({
      function: { name: "total", exported: true },
      interactions: [expect.objectContaining({ kind: "io" })],
      dataflow: { interactionResultNames: expect.arrayContaining(["rate"]) },
    });
    expect(evidence?.calculations.length).toBeGreaterThan(0);
    expect(evidence?.dataflow.calculationUsesInteractionResult).toBe(true);
  });

  it("reports clock reads beside branching", () => {
    const { candidate, projectFiles } = changedFunction(
      "export function dispose(total: number): number {\n"
      + "  const hour = new Date().getHours();\n"
      + "  if (hour < 9 || hour > 17) return total;\n"
      + "  return total * 0.9;\n"
      + "}\n",
    );

    const evidence = buildMixedCalculationAndInteractionEvidence(candidate, projectFiles);

    expect(evidence?.interactions.some(({ kind }) => kind === "time")).toBe(true);
    expect(evidence?.calculations.some(({ kind }) => kind === "branch" || kind === "comparison")).toBe(true);
  });

  it("abstains for a thin adapter with no calculation half", () => {
    const { candidate, projectFiles } = changedFunction(
      "import fs from \"node:fs/promises\";\n"
      + "export async function getRate(): Promise<number> {\n"
      + "  const raw = await fs.readFile(\"./rate.json\", \"utf8\");\n"
      + "  return JSON.parse(raw).rate;\n"
      + "}\n",
    );

    expect(buildMixedCalculationAndInteractionEvidence(candidate, projectFiles)).toBeUndefined();
  });

  it("abstains for a pure calculation with no interaction", () => {
    const { candidate, projectFiles } = changedFunction(
      "export function total(items: Array<{ price: number }>, rate: number): number {\n"
      + "  return items.reduce((sum, item) => sum + item.price * rate, 0);\n"
      + "}\n",
    );

    expect(buildMixedCalculationAndInteractionEvidence(candidate, projectFiles)).toBeUndefined();
  });
});
