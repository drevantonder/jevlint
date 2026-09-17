import { describe, expect, it } from "vitest";
import { buildBarrelWideReexportEvidence } from "../src/evidence/barrel-wide-reexport.js";
import type { Candidate, ProjectFile, SourceFile } from "../src/types.js";

const beforeBarrel = `export { ShopCart } from "./cart.js";
`;

const afterWide = `export { ShopCart } from "./cart.js";
export * from "../billing.js";
export * from "./widgets/button.js";
`;

const afterCohesive = `export { ShopCart } from "./cart.js";
export { ShopTotal } from "./cart-total.js";
`;

const cart = `export function ShopCart() {
  return {};
}
`;

const cartTotal = `export function ShopTotal() {
  return 0;
}
`;

const billing = `export function invoice() {
  return {};
}
`;

const button = `export function Button() {
  return {};
}
`;

function candidate(filePath: string): Candidate {
  return {
    id: "change_0",
    kind: "change",
    filePath,
    source: "Whole change. Use the rule-specific before/after evidence.",
    start: 0,
    end: 1,
    startLine: 1,
    startColumn: 1,
    endLine: 1,
    endColumn: 1,
  };
}

type Scenario = { changes: SourceFile[]; projectFiles: ProjectFile[] };

function scenario(after: string): Scenario {
  const changes: SourceFile[] = [{
    filePath: "src/shop/index.ts",
    source: after,
    oldSource: beforeBarrel,
    changedLines: [{ start: 2, end: 4 }],
  }];
  const projectFiles: ProjectFile[] = [
    { filePath: "src/shop/index.ts", source: after },
    { filePath: "src/shop/cart.ts", source: cart },
    { filePath: "src/shop/cart-total.ts", source: cartTotal },
    { filePath: "src/billing.ts", source: billing },
    { filePath: "src/shop/widgets/button.ts", source: button },
  ];
  return { changes, projectFiles };
}

describe("barrel wide reexport evidence", () => {
  it("reports wildcard re-exports added across unrelated directories", () => {
    const { changes, projectFiles } = scenario(afterWide);
    const evidence = buildBarrelWideReexportEvidence(
      candidate("src/shop/index.ts"),
      changes,
      projectFiles,
    );

    expect(evidence).toMatchObject({ barrelFile: "src/shop/index.ts" });
    expect(evidence?.additions.map(({ target }) => target))
      .toEqual(["../billing.js", "./widgets/button.js"]);
    expect(evidence?.additions.every(({ wildcard }) => wildcard)).toBe(true);
    expect(evidence?.distinctDirectories).toBe(2);
  });

  it("reports a cohesive sibling addition with one directory", () => {
    const { changes, projectFiles } = scenario(afterCohesive);
    const evidence = buildBarrelWideReexportEvidence(
      candidate("src/shop/index.ts"),
      changes,
      projectFiles,
    );

    expect(evidence?.additions.map(({ target }) => target)).toEqual(["./cart-total.js"]);
    expect(evidence?.distinctDirectories).toBe(1);
  });

  it("abstains when the changed file is not a barrel", () => {
    const changes: SourceFile[] = [{
      filePath: "src/shop/cart.ts",
      source: `export * from "../billing.js";\n${cart}`,
      oldSource: cart,
      changedLines: [{ start: 1, end: 1 }],
    }];
    const projectFiles: ProjectFile[] = [
      { filePath: "src/shop/cart.ts", source: changes[0]!.source },
      { filePath: "src/billing.ts", source: billing },
    ];
    expect(buildBarrelWideReexportEvidence(
      candidate("src/shop/cart.ts"),
      changes,
      projectFiles,
    )).toBeUndefined();
  });
});
