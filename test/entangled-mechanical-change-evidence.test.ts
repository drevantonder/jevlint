import { describe, expect, it } from "vitest";
import { buildEntangledMechanicalChangeEvidence } from "../src/evidence/entangled-mechanical-change.js";
import type { Candidate, SourceFile } from "../src/types.js";

function candidate(filePath: string): Candidate {
  return {
    id: "change_0",
    kind: "change",
    filePath,
    source: "Whole change across 1 file.",
    start: 0,
    end: 22,
    startLine: 1,
    startColumn: 1,
    endLine: 1,
    endColumn: 1,
  };
}

const OLD_LIB = "import { b } from \"./b.js\";\n"
  + "import { a } from \"./a.js\";\n"
  + "export function total(x: number): number {\n"
  + "  return x + 1;\n"
  + "}\n";
const REORDERED_SEMANTIC = "import { a } from \"./a.js\";\n"
  + "import { b } from \"./b.js\";\n"
  + "export function total(x: number): number {\n"
  + "  return x + 2;\n"
  + "}\n";
const REORDERED_ONLY = "import { a } from \"./a.js\";\n"
  + "import { b } from \"./b.js\";\n"
  + "export function total(x: number): number {\n"
  + "  return x + 1;\n"
  + "}\n";
const SEMANTIC_ONLY = "import { b } from \"./b.js\";\n"
  + "import { a } from \"./a.js\";\n"
  + "export function total(x: number): number {\n"
  + "  return x + 2;\n"
  + "}\n";

function change(source: string, oldSource: string | null): SourceFile[] {
  return [{
    filePath: "src/lib.ts",
    source,
    oldSource,
    changedLines: [{ start: 1, end: source.split("\n").length }],
  }];
}

describe("entangled mechanical change evidence", () => {
  it("reports a hunk mixing an import reorder with a behavior edit", () => {
    const evidence = buildEntangledMechanicalChangeEvidence(
      candidate("src/lib.ts"),
      change(REORDERED_SEMANTIC, OLD_LIB),
    );

    expect(evidence).toMatchObject({
      anchorFile: "src/lib.ts",
      coverage: { totalFiles: 1, includedFiles: 1, omittedFiles: 0 },
      modules: [
        {
          filePath: "src/lib.ts",
          status: "modified",
          selection: "anchor",
          entangledHunks: 1,
          hunks: [{ entangled: true, mechanicalLines: 2, semanticLines: 2 }],
        },
      ],
    });
  });

  it("abstains when the diff is wholly mechanical", () => {
    expect(buildEntangledMechanicalChangeEvidence(
      candidate("src/lib.ts"),
      change(REORDERED_ONLY, OLD_LIB),
    )).toBeUndefined();
  });

  it("abstains when the diff is wholly semantic", () => {
    expect(buildEntangledMechanicalChangeEvidence(
      candidate("src/lib.ts"),
      change(SEMANTIC_ONLY, OLD_LIB),
    )).toBeUndefined();
  });

  it("abstains for added files and non-change candidates", () => {
    expect(buildEntangledMechanicalChangeEvidence(
      candidate("src/lib.ts"),
      change(REORDERED_SEMANTIC, null),
    )).toBeUndefined();

    const functionCandidate: Candidate = { ...candidate("src/lib.ts"), kind: "function" };
    expect(buildEntangledMechanicalChangeEvidence(
      functionCandidate,
      change(REORDERED_SEMANTIC, OLD_LIB),
    )).toBeUndefined();
  });
});
