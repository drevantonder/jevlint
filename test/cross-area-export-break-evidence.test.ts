import { describe, expect, it } from "vitest";
import { buildCrossAreaExportBreakEvidence } from "../src/evidence/cross-area-export-break.js";
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

function functionCandidate(filePath: string): Candidate {
  return { ...moduleCandidate(filePath), id: "candidate_0", kind: "function" };
}

const invoiceBefore = `export function total(items: number[]) {
  return items.length;
}
export function refund(id: string) {
  return id;
}
`;

const invoiceAfter = `export function total(items: number[]) {
  return items.length;
}
`;

const importer = (name: string) => `import { refund } from "../billing/invoice.js";
export function ${name}() {
  return refund("x");
}
`;

function repo(invoiceSource: string, invoiceOld: string | null, extraChanges: SourceFile[] = []) {
  const files = [
    projectFile("billing/invoice.ts", invoiceSource),
    projectFile("orders/cart.ts", importer("cart")),
    projectFile("shipping/label.ts", importer("label")),
    projectFile("invoicing/pay.ts", importer("pay")),
    projectFile("billing/invoice.test.ts", importer("check")),
    ...Array.from({ length: 8 }, (_, index) => projectFile(`extra/widget-${index}.ts`)),
  ];
  const changes: SourceFile[] = [{
    filePath: "billing/invoice.ts",
    source: invoiceSource,
    oldSource: invoiceOld,
    changedLines: [{ start: 1, end: 8 }],
  }, ...extraChanges];
  return { files, changes };
}

describe("cross-area export break evidence", () => {
  it("groups importers of a removed export by area with runtime/test split", () => {
    const { files, changes } = repo(invoiceAfter, invoiceBefore);

    const evidence = buildCrossAreaExportBreakEvidence(moduleCandidate("billing/invoice.ts"), files, changes);

    expect(evidence?.removedExports).toEqual([{ exportName: "refund", barrelReExported: false }]);
    expect(evidence?.distinctAreas).toBe(4);
    expect(evidence?.runtimeAreaCount).toBe(3);
    const orders = evidence?.areas.find((group) => group.area === "orders");
    expect(orders?.runtimeImporters).toEqual(["orders/cart.ts"]);
    const billing = evidence?.areas.find((group) => group.area === "billing");
    expect(billing?.testImporters).toEqual(["billing/invoice.test.ts"]);
    expect(evidence?.areas.every((group) => group.updatedInSameDiff.length === 0)).toBe(true);
  });

  it("marks importers already updated in the same diff", () => {
    const paySource = importer("pay");
    const { files, changes } = repo(invoiceAfter, invoiceBefore, [{
      filePath: "invoicing/pay.ts",
      source: paySource,
      oldSource: paySource,
      changedLines: [{ start: 1, end: 1 }],
    }]);

    const evidence = buildCrossAreaExportBreakEvidence(moduleCandidate("billing/invoice.ts"), files, changes);

    const invoicing = evidence?.areas.find((group) => group.area === "invoicing");
    expect(invoicing?.updatedInSameDiff).toEqual(["invoicing/pay.ts"]);
  });

  it("abstains on additive-only export diffs", () => {
    const grown = `${invoiceBefore}export const extra = 1;\n`;
    const { files, changes } = repo(grown, invoiceBefore);

    expect(buildCrossAreaExportBreakEvidence(moduleCandidate("billing/invoice.ts"), files, changes)).toBeUndefined();
  });

  it("abstains when nothing imports the module", () => {
    const files = [
      projectFile("billing/invoice.ts", invoiceAfter),
      ...Array.from({ length: 10 }, (_, index) => projectFile(`extra/widget-${index}.ts`)),
    ];
    const changes: SourceFile[] = [{
      filePath: "billing/invoice.ts",
      source: invoiceAfter,
      oldSource: invoiceBefore,
      changedLines: [{ start: 1, end: 8 }],
    }];

    expect(buildCrossAreaExportBreakEvidence(moduleCandidate("billing/invoice.ts"), files, changes)).toBeUndefined();
  });

  it("abstains for non-module candidates", () => {
    const { files, changes } = repo(invoiceAfter, invoiceBefore);

    expect(buildCrossAreaExportBreakEvidence(functionCandidate("billing/invoice.ts"), files, changes)).toBeUndefined();
  });
});
