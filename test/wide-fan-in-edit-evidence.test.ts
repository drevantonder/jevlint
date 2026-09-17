import { readFile } from "node:fs/promises";
import { describe, expect, it } from "vitest";
import { buildWideFanInEditEvidence } from "../src/evidence/wide-fan-in-edit.js";
import { buildRuleEvidence } from "../src/evidence/index.js";
import type { Candidate, ProjectFile, SourceFile } from "../src/types.js";

const root = new URL("./fixtures/repositories/wide-fan-in-edit-smelly/", import.meta.url);

async function load(filePath: string): Promise<ProjectFile> {
  return { filePath, source: await readFile(new URL(filePath, root), "utf8") };
}

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

describe("wide fan in edit evidence", () => {
  it("carries caller counts for behaviorally edited functions", async () => {
    const [afterFile, a, b, c] = await Promise.all([
      load("src/format.after.ts"),
      load("src/a.ts"),
      load("src/b.ts"),
      load("src/c.ts"),
    ]);
    const before = await readFile(new URL("src/format.before.ts", root), "utf8");
    const filePath = "src/format.ts";
    const projectFiles = [
      { filePath, source: afterFile.source },
      a,
      b,
      c,
    ];
    const changes: SourceFile[] = [{
      filePath,
      source: afterFile.source,
      oldSource: before,
      changedLines: [{ start: 1, end: 3 }],
    }];

    const evidence = buildWideFanInEditEvidence(candidate(filePath), changes, projectFiles);

    expect(evidence?.anchorFile).toBe(filePath);
    expect(evidence?.editedFunctions).toHaveLength(1);
    expect(evidence?.editedFunctions[0]).toMatchObject({
      filePath,
      name: "format",
      exported: true,
    });
    expect(evidence?.editedFunctions[0]?.fanInTotal).toBeGreaterThanOrEqual(3);
    expect(evidence?.editedFunctions[0]?.distinctFiles).toBeGreaterThanOrEqual(3);
  });

  it("abstains when the edit preserves every function body", async () => {
    const source = `export function format(code: string): string {
  return code.trim().toLowerCase();
}
`;
    const filePath = "src/format.ts";
    const projectFiles = [{ filePath, source }];
    const changes: SourceFile[] = [{
      filePath,
      source,
      oldSource: source,
      changedLines: [{ start: 1, end: 3 }],
    }];

    expect(buildWideFanInEditEvidence(candidate(filePath), changes, projectFiles))
      .toBeUndefined();
  });

  it("dispatches through the rule registry", async () => {
    const [afterFile, a, b, c] = await Promise.all([
      load("src/format.after.ts"),
      load("src/a.ts"),
      load("src/b.ts"),
      load("src/c.ts"),
    ]);
    const before = await readFile(new URL("src/format.before.ts", root), "utf8");
    const filePath = "src/format.ts";
    const projectFiles = [
      { filePath, source: afterFile.source },
      a,
      b,
      c,
    ];
    const changes: SourceFile[] = [{
      filePath,
      source: afterFile.source,
      oldSource: before,
      changedLines: [{ start: 1, end: 3 }],
    }];

    const result = buildRuleEvidence(
      "jev/no-wide-fan-in-edit",
      candidate(filePath),
      projectFiles,
      changes,
    );

    expect(result.handled).toBe(true);
    expect(result.handled && result.evidence).toBeDefined();
  });
});
