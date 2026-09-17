import { describe, expect, it } from "vitest";
import { buildMysteryLiteralArgumentEvidence } from "../src/evidence/mystery-literal-argument.js";
import type { Candidate, SourceFile } from "../src/types.js";

const CALLEE = `export function render(data: string, mode: string): string {
  if (mode === "compact") {
    return data.slice(0, 10);
  }
  if (mode === "full") {
    return data;
  }
  return data.trim();
}
`;

const CALLER_SMELLY = `import { render } from "./render.js";

export function preview(data: string): string {
  return render(data, "compact");
}

export function detail(data: string): string {
  return render(data, "full");
}
`;

const CALLER_CLEAN = `import { render } from "./render.js";

export function preview(data: string, mode: string): string {
  return render(data, mode);
}
`;

function changeCandidate(filePath: string): Candidate {
  return {
    id: "change_0",
    kind: "change",
    filePath,
    source: "Whole change across 2 files.",
    start: 0,
    end: 10,
    startLine: 1,
    startColumn: 1,
    endLine: 1,
    endColumn: 1,
  };
}

function change(filePath: string, source: string): SourceFile {
  return {
    filePath,
    source,
    oldSource: source,
    changedLines: [{ start: 1, end: source.split("\n").length }],
  };
}

describe("mystery literal argument evidence", () => {
  it("reports changed-line literals that select a callee branch", () => {
    const changes = [change("src/render.ts", CALLEE), change("src/page.ts", CALLER_SMELLY)];
    const evidence = buildMysteryLiteralArgumentEvidence(changeCandidate("src/page.ts"), changes);

    expect(evidence).toMatchObject({
      anchorFile: "src/page.ts",
    });
    expect(evidence?.callSites).toHaveLength(2);
    expect(evidence?.callSites).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          filePath: "src/page.ts",
          callee: "render",
          parameterName: "mode",
          literal: "compact",
          literalKind: "string",
          conventional: false,
          calleeBranchesOnParameter: true,
          calleeComparesParameterToLiteral: true,
        }),
      ]),
    );
  });

  it("abstains when changed calls pass no behavior-selecting literal", () => {
    const changes = [change("src/render.ts", CALLEE), change("src/page.ts", CALLER_CLEAN)];

    expect(buildMysteryLiteralArgumentEvidence(changeCandidate("src/page.ts"), changes)).toBeUndefined();
  });

  it("abstains for non-change candidates", () => {
    const changes = [change("src/render.ts", CALLEE), change("src/page.ts", CALLER_SMELLY)];

    expect(
      buildMysteryLiteralArgumentEvidence({ ...changeCandidate("src/page.ts"), kind: "function" }, changes),
    ).toBeUndefined();
  });
});
