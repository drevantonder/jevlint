import { describe, expect, it } from "vitest";
import { buildBreakingExportEvidence } from "../src/evidence/breaking-export-reshape.js";
import type { Candidate, ProjectFile, SourceFile } from "../src/types.js";

const before = `export function getUser(id: string) {
  return { id };
}

export function getOrg(id: string) {
  return { id };
}
`;

const afterBreaking = `export function getUser(id: string, tenant: string) {
  return { id, tenant };
}

export function getOrg(id: string) {
  return { id };
}
`;

const afterCompatible = `export function getUser(id: string, tenant = "default") {
  return { id, tenant };
}

export function getOrg(id: string) {
  return { id };
}
`;

const callerSource = `import { getUser } from "./api";
export function handle(id: string) {
  return getUser(id);
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

type ChangeScenario = {
  changes: SourceFile[];
  projectFiles: ProjectFile[];
};

function change(source: string): ChangeScenario {
  const changes: SourceFile[] = [{
    filePath: "src/api.ts",
    source,
    oldSource: before,
    changedLines: [{ start: 1, end: 3 }],
  }];
  const projectFiles: ProjectFile[] = [
    { filePath: "src/api.ts", source },
    { filePath: "src/handler.ts", source: callerSource },
  ];
  return { changes, projectFiles };
}

describe("breaking export reshape evidence", () => {
  it("flags a newly required parameter with a stale caller", () => {
    const { changes, projectFiles } = change(afterBreaking);
    const evidence = buildBreakingExportEvidence(
      candidate("src/api.ts"),
      changes,
      projectFiles,
    );

    expect(evidence).toMatchObject({
      anchorFile: "src/api.ts",
      contractBreaks: [{
        exportName: "getUser",
        kind: "newly-required-parameter",
        shimPreserved: false,
      }],
    });
    expect(evidence?.contractBreaks[0]?.staleCallers).toHaveLength(1);
  });

  it("abstains when the new parameter keeps the old call working", () => {
    const { changes, projectFiles } = change(afterCompatible);
    const evidence = buildBreakingExportEvidence(
      candidate("src/api.ts"),
      changes,
      projectFiles,
    );

    expect(evidence).toBeUndefined();
  });
});
