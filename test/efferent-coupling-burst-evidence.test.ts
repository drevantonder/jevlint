import { describe, expect, it } from "vitest";
import { buildEfferentCouplingBurstEvidence } from "../src/evidence/efferent-coupling-burst.js";
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

const cartBefore = `import { total } from "../billing/invoice.js";
export function cart() {
  return total([]);
}
`;

const cartAfter = `import { total } from "../billing/invoice.js";
import { label } from "../shipping/label.js";
import { method } from "../payments/method.js";
import { formatMoney } from "../shared/money.js";
export function cart() {
  return [total([]), label(), method(), formatMoney(1)].join(",");
}
`;

function repo(cartSource: string, cartOld: string | null) {
  const files = [
    projectFile("billing/invoice.ts", "export function total(items: unknown[]) {\n  return items.length;\n}\n"),
    projectFile("shipping/label.ts", "export function label() {\n  return \"label\";\n}\n"),
    projectFile("payments/method.ts", "export function method() {\n  return \"card\";\n}\n"),
    projectFile("shared/money.ts", "export function formatMoney(amount: number) {\n  return String(amount);\n}\n"),
    projectFile("orders/cart.ts", cartSource),
    ...Array.from({ length: 8 }, (_, index) => projectFile(`extra/widget-${index}.ts`)),
  ];
  const changes: SourceFile[] = [{
    filePath: "orders/cart.ts",
    source: cartSource,
    oldSource: cartOld,
    changedLines: [{ start: 1, end: 4 }],
  }];
  return { files, changes };
}

describe("efferent coupling burst evidence", () => {
  it("captures added edges into new areas with roles and before/after counts", () => {
    const { files, changes } = repo(cartAfter, cartBefore);

    const evidence = buildEfferentCouplingBurstEvidence(moduleCandidate("orders/cart.ts"), files, changes);

    expect(evidence?.newEdges).toHaveLength(3);
    expect(evidence?.distinctNewAreas).toBe(3);
    expect(evidence?.beforeAreas).toBe(1);
    expect(evidence?.afterAreas).toBe(4);
    expect(evidence?.featureGrouping).toBe("mixed");
    const shared = evidence?.newEdges.find((edge) => edge.targetTopDir === "shared");
    expect(shared?.targetRole).toBe("shared");
    expect(shared?.crossesTopDir).toBe(true);
    expect(shared?.typeOnly).toBe(false);
    expect(evidence?.newEdges.every((edge) => edge.external === false)).toBe(true);
  });

  it("flags type-only added edges", () => {
    const typed = `import { total } from "../billing/invoice.js";
import type { method } from "../payments/method.js";
export function cart() {
  return String(total([]));
}
`;
    const { files, changes } = repo(typed, cartBefore);

    const evidence = buildEfferentCouplingBurstEvidence(moduleCandidate("orders/cart.ts"), files, changes);

    expect(evidence?.newEdges).toHaveLength(1);
    expect(evidence?.newEdges[0]?.typeOnly).toBe(true);
  });

  it("abstains when the diff adds no outbound edge", () => {
    const { files, changes } = repo(cartBefore, cartBefore);

    expect(buildEfferentCouplingBurstEvidence(moduleCandidate("orders/cart.ts"), files, changes)).toBeUndefined();
  });

  it("abstains for non-module candidates", () => {
    const { files, changes } = repo(cartAfter, cartBefore);

    expect(
      buildEfferentCouplingBurstEvidence({ ...moduleCandidate("orders/cart.ts"), kind: "change" }, files, changes),
    ).toBeUndefined();
  });
});
