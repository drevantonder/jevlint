import { describe, expect, it } from "vitest";
import { buildSameStemDivergentRoleEvidence } from "../src/evidence/same-stem-divergent-role.js";
import type { Candidate, ProjectFile, SourceFile } from "../src/types.js";

function projectFile(filePath: string, source = "export const value = 1;\n"): ProjectFile {
  return { filePath, source };
}

function moduleCandidate(filePath: string): Candidate {
  return {
    id: "module_0",
    kind: "module",
    filePath,
    source: "",
    start: 0,
    end: 0,
    startLine: 1,
    startColumn: 1,
    endLine: 1,
    endColumn: 1,
  };
}

const billingBefore = `export function createInvoice(id: string) {
  return id;
}
`;

const billingAfter = `export function createInvoice(id: string) {
  return id;
}
export function chargeCard(id: string) {
  return id;
}
`;

const shippingStore = `export function createShipment(id: string) {
  return id;
}
export function trackParcel(id: string) {
  return id;
}
`;

const clientOfBoth = `import { createInvoice } from "../billing/store.js";
import { createShipment } from "../shipping/store.js";
export function checkout(id: string) {
  return createInvoice(id) + createShipment(id);
}
`;

function repo(billingSource: string, billingOld: string | null, shippingSource = shippingStore) {
  const files = [
    projectFile("billing/store.ts", billingSource),
    projectFile("billing/helper.ts", `export function help() {\n  return 1;\n}\n`),
    projectFile("shipping/store.ts", shippingSource),
    projectFile("shipping/helper.ts", `export function help() {\n  return 2;\n}\n`),
    projectFile("orders/checkout.ts", clientOfBoth),
    ...Array.from({ length: 7 }, (_, index) => projectFile(`extra/widget-${index}.ts`)),
  ];
  const changes: SourceFile[] = [{
    filePath: "billing/store.ts",
    source: billingSource,
    oldSource: billingOld,
    changedLines: [{ start: 4, end: 6 }],
  }];
  return { files, changes };
}

describe("same stem divergent role evidence", () => {
  it("captures a same-stem twin with disjoint exports and a shared client area", () => {
    const { files, changes } = repo(billingAfter, billingBefore);

    const evidence = buildSameStemDivergentRoleEvidence(
      moduleCandidate("billing/store.ts"),
      files,
      changes,
    );

    expect(evidence?.stem).toBe("store");
    expect(evidence?.candidateExports).toEqual(["createInvoice", "chargeCard"]);
    expect(evidence?.twins).toHaveLength(1);
    expect(evidence?.twins[0]).toMatchObject({
      filePath: "shipping/store.ts",
      sharedExports: [],
      overlapRatio: 0,
    });
    expect(evidence?.twins[0]?.exports).toEqual(["createShipment", "trackParcel"]);
    expect(evidence?.sharedClientAreas).toEqual(["orders"]);
  });

  it("defers to duplication judgments when exports overlap", () => {
    const overlapping = `export function createInvoice(id: string) {\n  return id;\n}\nexport function trackParcel(id: string) {\n  return id;\n}\n`;
    const { files, changes } = repo(billingAfter, billingBefore, overlapping);

    expect(
      buildSameStemDivergentRoleEvidence(moduleCandidate("billing/store.ts"), files, changes),
    ).toBeUndefined();
  });

  it("abstains when the export set did not change", () => {
    const { files, changes } = repo(billingAfter, billingAfter);

    expect(
      buildSameStemDivergentRoleEvidence(moduleCandidate("billing/store.ts"), files, changes),
    ).toBeUndefined();
  });

  it("fires for added files sharing a stem with another area", () => {
    const files = [
      projectFile("billing/store.ts", billingBefore),
      projectFile("refunds/store.ts", shippingStore),
      projectFile("refunds/helper.ts", `export function help() {\n  return 3;\n}\n`),
      ...Array.from({ length: 8 }, (_, index) => projectFile(`extra/widget-${index}.ts`)),
    ];
    const changes: SourceFile[] = [{
      filePath: "refunds/store.ts",
      source: shippingStore,
      oldSource: null,
      changedLines: [{ start: 1, end: 6 }],
    }];

    const evidence = buildSameStemDivergentRoleEvidence(
      moduleCandidate("refunds/store.ts"),
      files,
      changes,
    );

    expect(evidence?.twins.map((twin) => twin.filePath)).toContain("billing/store.ts");
  });

  it("abstains for non-module candidates", () => {
    const { files, changes } = repo(billingAfter, billingBefore);

    expect(
      buildSameStemDivergentRoleEvidence(
        { ...moduleCandidate("billing/store.ts"), kind: "change" },
        files,
        changes,
      ),
    ).toBeUndefined();
  });
});
