import { describe, expect, it } from "vitest";
import { buildImportCycleTangleEvidence } from "../src/evidence/import-cycle-tangle.js";
import type { Candidate, ProjectFile, SourceFile } from "../src/types.js";

const afterOrder = `import { charge } from "../adapters/stripe.js";
export function placeOrder() {
  return charge();
}
`;

const beforeOrder = `export function placeOrder() {
  return "pending";
}
`;

const stripe = `import { placeOrder } from "../domain/order.js";
export function charge() {
  return placeOrder();
}
`;

const acyclicStripe = `export function charge() {
  return "ok";
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

type Scenario = {
  changes: SourceFile[];
  projectFiles: ProjectFile[];
};

function scenario(after: string, before: string | null, stripeSource: string): Scenario {
  const changes: SourceFile[] = [{
    filePath: "src/domain/order.ts",
    source: after,
    oldSource: before,
    changedLines: [{ start: 1, end: 4 }],
  }];
  const projectFiles: ProjectFile[] = [
    { filePath: "src/domain/order.ts", source: after },
    { filePath: "src/adapters/stripe.ts", source: stripeSource },
  ];
  return { changes, projectFiles };
}

describe("import cycle tangle evidence", () => {
  it("reports a value-import cycle across layer directories", () => {
    const { changes, projectFiles } = scenario(afterOrder, beforeOrder, stripe);
    const evidence = buildImportCycleTangleEvidence(
      candidate("src/domain/order.ts"),
      changes,
      projectFiles,
    );

    expect(evidence).toMatchObject({
      anchorFile: "src/domain/order.ts",
      closingEdgeIsNew: true,
    });
    expect(evidence?.cycle).toEqual([
      "src/domain/order.ts",
      "src/adapters/stripe.ts",
      "src/domain/order.ts",
    ]);
    expect(evidence?.edges.map(({ valueImport }) => valueImport)).toEqual([true, true]);
    expect(evidence?.directorySegments).toEqual([["src", "domain"], ["src", "adapters"]]);
  });

  it("abstains when the changed file sits on no cycle", () => {
    const { changes, projectFiles } = scenario(afterOrder, beforeOrder, acyclicStripe);
    expect(buildImportCycleTangleEvidence(
      candidate("src/domain/order.ts"),
      changes,
      projectFiles,
    )).toBeUndefined();
  });

  it("abstains for non-change candidates", () => {
    const { changes, projectFiles } = scenario(afterOrder, beforeOrder, stripe);
    expect(buildImportCycleTangleEvidence(
      { ...candidate("src/domain/order.ts"), kind: "function" },
      changes,
      projectFiles,
    )).toBeUndefined();
  });
});
