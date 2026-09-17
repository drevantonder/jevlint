import { describe, expect, it } from "vitest";
import { buildStableToVolatileEdgeEvidence } from "../src/evidence/stable-to-volatile-edge.js";
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

const invoiceBefore = `export function total(items: number[]) {
  return items.length;
}
`;

const invoiceAfter = `import { tweak } from "./internal-helper.js";
export function total(items: number[]) {
  return tweak(items.length);
}
`;

const helper = `/** @internal */
export function tweak(count: number) {
  return count + 1;
}
`;

const importer = (name: string) => `import { total } from "../billing/invoice.js";
export function ${name}() {
  return total([]);
}
`;

function repo(invoiceSource: string, helperOld: string | null) {
  const files = [
    projectFile("billing/invoice.ts", invoiceSource),
    projectFile("billing/internal-helper.ts", helper),
    projectFile("orders/cart.ts", importer("cart")),
    projectFile("shipping/label.ts", importer("label")),
    projectFile("invoicing/pay.ts", importer("pay")),
    ...Array.from({ length: 8 }, (_, index) => projectFile(`extra/widget-${index}.ts`)),
  ];
  const changes: SourceFile[] = [
    {
      filePath: "billing/invoice.ts",
      source: invoiceSource,
      oldSource: invoiceBefore,
      changedLines: [{ start: 1, end: 1 }],
    },
    {
      filePath: "billing/internal-helper.ts",
      source: helper,
      oldSource: helperOld,
      changedLines: [{ start: 1, end: 4 }],
    },
  ];
  return { files, changes };
}

describe("stable to volatile edge evidence", () => {
  it("weighs a new edge from a fanned-in owner into a zero-importer helper", () => {
    const { files, changes } = repo(invoiceAfter, null);

    const evidence = buildStableToVolatileEdgeEvidence(moduleCandidate("billing/invoice.ts"), files, changes);

    expect(evidence?.ownerImporters).toBe(3);
    expect(evidence?.ownerImporterAreas).toBe(3);
    expect(evidence?.newEdges).toHaveLength(1);
    const edge = evidence?.newEdges[0];
    expect(edge?.resolved).toBe("billing/internal-helper.ts");
    expect(edge?.zeroImporters).toBe(true);
    expect(edge?.newlyAdded).toBe(true);
    expect(edge?.internalMarked).toBe(true);
    expect(edge?.typeOnly).toBe(false);
    expect(edge?.testMarked).toBe(false);
  });

  it("marks pre-existing volatile targets as not newly added", () => {
    const { files, changes } = repo(invoiceAfter, helper);

    const evidence = buildStableToVolatileEdgeEvidence(moduleCandidate("billing/invoice.ts"), files, changes);

    expect(evidence?.newEdges[0]?.newlyAdded).toBe(false);
  });

  it("abstains when the diff adds no new edge", () => {
    const { files, changes } = repo(invoiceBefore, helper);

    expect(buildStableToVolatileEdgeEvidence(moduleCandidate("billing/invoice.ts"), files, changes)).toBeUndefined();
  });

  it("abstains for non-module candidates", () => {
    const { files, changes } = repo(invoiceAfter, null);

    expect(
      buildStableToVolatileEdgeEvidence({ ...moduleCandidate("billing/invoice.ts"), kind: "function" }, files, changes),
    ).toBeUndefined();
  });
});
