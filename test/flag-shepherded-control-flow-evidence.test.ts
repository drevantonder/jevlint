import { describe, expect, it } from "vitest";
import { extractCandidates } from "../src/candidates.js";
import { buildFlagShepherdedControlFlowEvidence } from "../src/evidence/flag-shepherded-control-flow.js";
import type { ProjectFile } from "../src/types.js";

const smellySource = `export function summarizeOrders(orders: Array<{ total: number }>): string {
  let failed = false;
  let summary = "";
  for (const order of orders) {
    if (order.total < 0) {
      failed = true;
    }
    summary += order.total + ";";
  }
  if (failed) {
    return "invalid";
  }
  return summary;
}
`;

const returnedSource = `export function checkAll(items: number[]): boolean {
  let ok = true;
  for (const item of items) {
    if (item < 0) {
      ok = false;
    }
  }
  return ok;
}
`;

const dataReadSource = `export function describe(items: number[]): string {
  let empty = true;
  for (const item of items) {
    if (item > 0) {
      empty = false;
    }
  }
  const note = "empty was " + empty;
  if (empty) {
    return "none";
  }
  return note;
}
`;

const accumulatorSource = `export function total(items: number[]): number {
  let sum = 0;
  for (const item of items) {
    sum += item;
  }
  return sum;
}
`;

function candidateFor(source: string, filePath: string) {
  return extractCandidates(filePath, source).find(({ kind }) => kind === "function");
}

describe("flag shepherded control flow evidence", () => {
  it("extracts a write-then-branch flag with no other readers", () => {
    const files: ProjectFile[] = [{ filePath: "src/orders.ts", source: smellySource }];
    const candidate = candidateFor(smellySource, "src/orders.ts");
    expect(candidate).toBeDefined();
    if (!candidate) return;

    const evidence = buildFlagShepherdedControlFlowEvidence(candidate, files);

    expect(evidence).toMatchObject({
      function: { name: "summarizeOrders", filePath: "src/orders.ts" },
      flags: [
        {
          name: "failed",
          initKind: "boolean",
          returned: false,
          passedAsArgument: false,
          capturedByNested: false,
          dataReads: 0,
        },
      ],
    });
    expect(evidence?.flags[0]?.testReads).toHaveLength(1);
    expect(evidence?.flags[0]?.writes).toHaveLength(1);
    expect(evidence?.flags[0]?.writeToBranchLines).toBeGreaterThan(0);
  });

  it("abstains when the flag escapes through the return value", () => {
    const files: ProjectFile[] = [{ filePath: "src/check.ts", source: returnedSource }];
    const candidate = candidateFor(returnedSource, "src/check.ts");
    expect(candidate).toBeDefined();
    if (!candidate) return;

    const evidence = buildFlagShepherdedControlFlowEvidence(candidate, files);

    expect(evidence).toBeUndefined();
  });

  it("abstains when the flag is also read as domain data", () => {
    const files: ProjectFile[] = [{ filePath: "src/describe.ts", source: dataReadSource }];
    const candidate = candidateFor(dataReadSource, "src/describe.ts");
    expect(candidate).toBeDefined();
    if (!candidate) return;

    expect(buildFlagShepherdedControlFlowEvidence(candidate, files)).toBeUndefined();
  });

  it("abstains for numeric accumulators that hold domain state", () => {
    const files: ProjectFile[] = [{ filePath: "src/total.ts", source: accumulatorSource }];
    const candidate = candidateFor(accumulatorSource, "src/total.ts");
    expect(candidate).toBeDefined();
    if (!candidate) return;

    expect(buildFlagShepherdedControlFlowEvidence(candidate, files)).toBeUndefined();
  });
});
