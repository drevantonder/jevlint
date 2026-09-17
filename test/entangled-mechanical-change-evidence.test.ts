import { describe, expect, it } from "vitest";
import { buildEntangledMechanicalChangeEvidence } from "../src/evidence/entangled-mechanical-change.js";
import type { Candidate, SourceFile } from "../src/types.js";

const oldSource = `export function add(a: number, b: number): number {
  return a + b;
}
export function mul(a: number, b: number): number {
    return a  *  b;
}
`;

const newSource = `export function add(a: number, b: number): number {
    return a + b;
}
export function mul(a: number, b: number): number {
    return a  *  b;
}
export function sub(a: number, b: number): number {
  return a - b;
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

describe("entangled mechanical change evidence", () => {
  it("classifies whitespace-only and behavioral hunks in one file", () => {
    const change: SourceFile = {
      filePath: "src/math.ts",
      source: newSource,
      oldSource,
      changedLines: [{ start: 2, end: 2 }, { start: 7, end: 9 }],
    };

    const evidence = buildEntangledMechanicalChangeEvidence(candidate(change.filePath), [change], [
      { filePath: change.filePath, source: change.source },
    ]);

    expect(evidence).toMatchObject({
      anchorFile: "src/math.ts",
      totals: { mechanicalHunks: 1, behavioralHunks: 1 },
      files: [
        expect.objectContaining({
          filePath: "src/math.ts",
          status: "modified",
          selection: "anchor",
          mechanicalHunks: 1,
          behavioralHunks: 1,
          interleaved: true,
          hunks: [
            expect.objectContaining({ startLine: 2, endLine: 2, kind: "whitespace-only" }),
            expect.objectContaining({ startLine: 7, endLine: 9, kind: "behavioral" }),
          ],
        }),
      ],
    });
  });

  it("detects a rename-only hunk beside a behavioral hunk", () => {
    const before = `export function summarize(items: string[]): number {
  const total = count(items);
  return total;
}
`;
    const after = `export function summarize(entries: string[]): number {
  const tally = count(entries);
  return tally + entries.length;
}
`;
    const change: SourceFile = {
      filePath: "src/summary.ts",
      source: after,
      oldSource: before,
      changedLines: [{ start: 1, end: 1 }, { start: 3, end: 3 }],
    };

    const evidence = buildEntangledMechanicalChangeEvidence(candidate(change.filePath), [change]);

    expect(evidence?.totals).toMatchObject({ mechanicalHunks: 1, behavioralHunks: 1 });
    expect(evidence?.files[0]?.hunks[0]).toMatchObject({ kind: "rename-only" });
    expect(evidence?.files[0]?.hunks[1]).toMatchObject({ kind: "behavioral" });
  });

  it("abstains on a purely behavioral change", () => {
    const change: SourceFile = {
      filePath: "src/math.ts",
      source: newSource,
      oldSource,
      changedLines: [{ start: 7, end: 9 }],
    };

    expect(buildEntangledMechanicalChangeEvidence(candidate(change.filePath), [change])).toBeUndefined();
  });

  it("abstains on a purely whitespace change", () => {
    const change: SourceFile = {
      filePath: "src/math.ts",
      source: newSource,
      oldSource,
      changedLines: [{ start: 2, end: 2 }],
    };

    expect(buildEntangledMechanicalChangeEvidence(candidate(change.filePath), [change])).toBeUndefined();
  });
});
