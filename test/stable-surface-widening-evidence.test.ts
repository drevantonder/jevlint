import { describe, expect, it } from "vitest";
import { buildStableSurfaceWideningEvidence } from "../src/evidence/stable-surface-widening.js";
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

const pricingBefore = `export function calculateTotal(items: number[]) {
  return items.reduce((total, item) => total + item, 0);
}
`;

const pricingAfter = `export function calculateTotal(items: number[]) {
  return items.reduce((total, item) => total + item, 0);
}
export interface Invoice {
  id: string;
  total: number;
}
export function formatInvoice(invoice: Invoice) {
  return invoice.id;
}
`;

const barrel = `export { calculateTotal, formatInvoice } from "./pricing.js";
export type { Invoice } from "./pricing.js";
`;

function importer(area: string, name: string): ProjectFile {
  return projectFile(
    `${area}/${name}.ts`,
    `import { calculateTotal } from "../billing/pricing.js";\nexport const total = calculateTotal([1]);\n`,
  );
}

function repo(pricingSource: string, pricingOld: string | null) {
  const files = [
    projectFile("billing/pricing.ts", pricingSource),
    projectFile("billing/index.ts", barrel),
    importer("orders", "cart"),
    importer("shipping", "ship"),
    importer("invoicing", "pay"),
    projectFile("billing/pricing.test.ts", "import {} from './pricing';\n"),
    ...Array.from({ length: 6 }, (_, index) => projectFile(`extra/widget-${index}.ts`)),
  ];
  const changes: SourceFile[] = [{
    filePath: "billing/pricing.ts",
    source: pricingSource,
    oldSource: pricingOld,
    changedLines: [{ start: 4, end: 10 }],
  }];
  return { files, changes };
}

describe("stable surface widening evidence", () => {
  it("captures purely additive exports with cross-area fan-in and barrel blessing", () => {
    const { files, changes } = repo(pricingAfter, pricingBefore);

    const evidence = buildStableSurfaceWideningEvidence(
      moduleCandidate("billing/pricing.ts"),
      files,
      changes,
    );

    expect(evidence?.addedExports.map(({ name }) => name)).toEqual(["Invoice", "formatInvoice"]);
    expect(evidence?.totalImporters).toBe(5);
    expect(evidence?.distinctAreas).toBe(4);
    expect(evidence?.runtimeImporters).toBe(4);
    expect(evidence?.testImporters).toBe(1);
    expect(evidence?.barrelReExportsNew).toEqual(["Invoice", "formatInvoice"]);
    expect(evidence?.testMarked).toBe(false);
  });

  it("abstains when the diff removes or renames exports", () => {
    const removed = `export function calculateTotal(items: number[]) {\n  return items.length;\n}\n`;
    const { files, changes } = repo(removed, pricingAfter);

    expect(
      buildStableSurfaceWideningEvidence(moduleCandidate("billing/pricing.ts"), files, changes),
    ).toBeUndefined();
  });

  it("abstains when no exports are added", () => {
    const { files, changes } = repo(pricingBefore, pricingBefore);

    expect(
      buildStableSurfaceWideningEvidence(moduleCandidate("billing/pricing.ts"), files, changes),
    ).toBeUndefined();
  });

  it("abstains for brand-new files with no prior surface", () => {
    const { files, changes } = repo(pricingAfter, null);

    expect(
      buildStableSurfaceWideningEvidence(moduleCandidate("billing/pricing.ts"), files, changes),
    ).toBeUndefined();
  });

  it("abstains for non-module candidates", () => {
    const { files, changes } = repo(pricingAfter, pricingBefore);

    expect(
      buildStableSurfaceWideningEvidence(
        { ...moduleCandidate("billing/pricing.ts"), kind: "change" },
        files,
        changes,
      ),
    ).toBeUndefined();
  });
});
