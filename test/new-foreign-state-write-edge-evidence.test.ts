import { describe, expect, it } from "vitest";
import { buildNewForeignStateWriteEdgeEvidence } from "../src/evidence/new-foreign-state-write-edge.js";
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

const cartBefore = `export function add(item: string) {
  return item;
}
`;

const cartAfter = `import { cartState } from "../billing/store.js";
export function add(item: string) {
  cartState.items.push(item);
  return cartState.items.length;
}
`;

const cartReadOnly = `import { cartState } from "../billing/store.js";
export function count() {
  return cartState.items.length;
}
`;

const store = `export let cartState = { items: [] as string[] };
export function setCart(items: string[]) {
  cartState = { items };
}
`;

function repo(cartSource: string, cartOld: string | null) {
  const files = [
    projectFile("billing/store.ts", store),
    projectFile("orders/cart.ts", cartSource),
    ...Array.from({ length: 9 }, (_, index) => projectFile(`extra/widget-${index}.ts`)),
  ];
  const changes: SourceFile[] = [{
    filePath: "orders/cart.ts",
    source: cartSource,
    oldSource: cartOld,
    changedLines: [{ start: 1, end: 5 }],
  }];
  return { files, changes };
}

describe("new foreign state write edge evidence", () => {
  it("captures a first write across a new edge with target mutability and setters", () => {
    const { files, changes } = repo(cartAfter, cartBefore);

    const evidence = buildNewForeignStateWriteEdgeEvidence(moduleCandidate("orders/cart.ts"), files, changes);

    expect(evidence?.writes).toHaveLength(1);
    expect(evidence?.writes[0]).toMatchObject({
      target: "billing/store.ts",
      specifier: "../billing/store.js",
      operation: "mutating-call",
      targetIsTargetMutable: true,
      targetOffersSetter: true,
    });
    expect(evidence?.targetMutableBindings).toContain("cartState");
    expect(evidence?.targetSetterNames).toContain("setCart");
  });

  it("abstains when the new edge carries only reads", () => {
    const { files, changes } = repo(cartReadOnly, cartBefore);

    expect(buildNewForeignStateWriteEdgeEvidence(moduleCandidate("orders/cart.ts"), files, changes)).toBeUndefined();
  });

  it("abstains when the write travels a long-standing edge", () => {
    const { files, changes } = repo(cartAfter, cartAfter);

    expect(buildNewForeignStateWriteEdgeEvidence(moduleCandidate("orders/cart.ts"), files, changes)).toBeUndefined();
  });

  it("abstains for non-module candidates", () => {
    const { files, changes } = repo(cartAfter, cartBefore);

    expect(
      buildNewForeignStateWriteEdgeEvidence({ ...moduleCandidate("orders/cart.ts"), kind: "abstraction" }, files, changes),
    ).toBeUndefined();
  });
});
