import { describe, expect, it } from "vitest";
import { buildBarrelBypassEvidence } from "../src/evidence/barrel-bypass.js";
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

const calc = `export function calculateTotal(items: number[]) {
  return items.reduce((total, item) => total + item, 0);
}
`;

const barrel = `export { calculateTotal } from "./calc.js";
export { formatMoney } from "./format.js";
`;

const format = `export function formatMoney(amount: number) {
  return String(amount);
}
`;

const payBefore = `import { calculateTotal } from "../billing/index.js";
export function pay(items: number[]) {
  return calculateTotal(items);
}
`;

const payAfter = `import { calculateTotal } from "../billing/calc.js";
export function pay(items: number[]) {
  return calculateTotal(items);
}
`;

const ship = `import { calculateTotal } from "../billing/index.js";
export function ship(items: number[]) {
  return calculateTotal(items);
}
`;

function repo(paySource: string, payOld: string | null) {
  const files = [
    projectFile("features/billing/calc.ts", calc),
    projectFile("features/billing/format.ts", format),
    projectFile("features/billing/index.ts", barrel),
    projectFile("features/invoicing/pay.ts", paySource),
    projectFile("features/shipping/ship.ts", ship),
    projectFile("features/orders/cart.ts", ship.replace("ship", "cart")),
    ...Array.from({ length: 8 }, (_, index) => projectFile(`features/extra/widget-${index}.ts`)),
  ];
  const changes: SourceFile[] = [{
    filePath: "features/invoicing/pay.ts",
    source: paySource,
    oldSource: payOld,
    changedLines: [{ start: 1, end: 1 }],
  }];
  return { files, changes };
}

describe("barrel bypass evidence", () => {
  it("captures a new deep import for a barrelled symbol with adoption counts", () => {
    const { files, changes } = repo(payAfter, payBefore);

    const evidence = buildBarrelBypassEvidence(moduleCandidate("features/invoicing/pay.ts"), files, changes);

    expect(evidence?.bypass).toHaveLength(1);
    expect(evidence?.bypass[0]).toMatchObject({
      specifier: "../billing/calc.js",
      resolved: "features/billing/calc.ts",
      importedSymbols: ["calculateTotal"],
      barrel: "features/billing/index.ts",
    });
    expect(evidence?.bypass[0]?.barrelReExports).toContain("calculateTotal");
    expect(evidence?.adoption).toMatchObject({
      externalImporters: 2,
      viaBarrel: 2,
      ratio: 1,
    });
  });

  it("abstains when the new import already uses the barrel", () => {
    const { files, changes } = repo(payBefore, payAfter);

    expect(buildBarrelBypassEvidence(moduleCandidate("features/invoicing/pay.ts"), files, changes)).toBeUndefined();
  });

  it("abstains when the target directory publishes no barrel", () => {
    const files = [
      projectFile("features/billing/calc.ts", calc),
      projectFile("features/invoicing/pay.ts", payAfter),
      projectFile("features/shipping/ship.ts", ship),
      ...Array.from({ length: 8 }, (_, index) => projectFile(`features/extra/widget-${index}.ts`)),
    ];
    const changes: SourceFile[] = [{
      filePath: "features/invoicing/pay.ts",
      source: payAfter,
      oldSource: payBefore,
      changedLines: [{ start: 1, end: 1 }],
    }];

    expect(buildBarrelBypassEvidence(moduleCandidate("features/invoicing/pay.ts"), files, changes)).toBeUndefined();
  });

  it("abstains when the barrel re-export list is truncated", () => {
    const fatBarrel = Array.from(
      { length: 21 },
      (_, index) => `export { widget${index} } from "./widget-${index}.js";`,
    ).join("\n") + "\nexport { calculateTotal } from \"./calc.js\";\n";
    const files = [
      projectFile("features/billing/calc.ts", calc),
      projectFile("features/billing/format.ts", format),
      projectFile("features/billing/index.ts", fatBarrel),
      projectFile("features/invoicing/pay.ts", payAfter),
      projectFile("features/shipping/ship.ts", ship),
      projectFile("features/orders/cart.ts", ship.replace("ship", "cart")),
      ...Array.from({ length: 8 }, (_, index) => projectFile(`features/extra/widget-${index}.ts`)),
    ];
    const changes: SourceFile[] = [{
      filePath: "features/invoicing/pay.ts",
      source: payAfter,
      oldSource: payBefore,
      changedLines: [{ start: 1, end: 1 }],
    }];

    expect(buildBarrelBypassEvidence(moduleCandidate("features/invoicing/pay.ts"), files, changes)).toBeUndefined();
  });

  it("abstains when the barrel does not offer the imported symbol", () => {
    const thinBarrel = `export { formatMoney } from "./format.js";\n`;
    const files = [
      projectFile("features/billing/calc.ts", calc),
      projectFile("features/billing/format.ts", format),
      projectFile("features/billing/index.ts", thinBarrel),
      projectFile("features/invoicing/pay.ts", payAfter),
      projectFile("features/shipping/ship.ts", ship),
      ...Array.from({ length: 8 }, (_, index) => projectFile(`features/extra/widget-${index}.ts`)),
    ];
    const changes: SourceFile[] = [{
      filePath: "features/invoicing/pay.ts",
      source: payAfter,
      oldSource: payBefore,
      changedLines: [{ start: 1, end: 1 }],
    }];

    expect(buildBarrelBypassEvidence(moduleCandidate("features/invoicing/pay.ts"), files, changes)).toBeUndefined();
  });
});
