import { describe, expect, it } from "vitest";
import { buildContractNarrowingEvidence } from "../src/evidence/contract-narrowing-after-ship.js";
import type { Candidate, ProjectFile, SourceFile } from "../src/types.js";

const beforeApi = `export type ListOptions = {
  limit?: number;
};
export function listUsers(options: ListOptions): string[] {
  return [];
}
`;

const afterRequired = `export type ListOptions = {
  limit?: number;
  tenant: string;
};
export function listUsers(options: ListOptions): string[] {
  return [];
}
`;

const afterOptional = `export type ListOptions = {
  limit?: number;
  tenant?: string;
};
export function listUsers(options: ListOptions): string[] {
  return [];
}
`;

const afterPositional = `export type ListOptions = {
  limit?: number;
};
export function listUsers(options: ListOptions, tenant: string): string[] {
  return [tenant];
}
`;

const staleCaller = `import { listUsers } from "./api";
export function handle(): string[] {
  return listUsers({});
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

function scenario(after: string, changedEnd: number): ChangeScenario {
  const changes: SourceFile[] = [{
    filePath: "src/api.ts",
    source: after,
    oldSource: beforeApi,
    changedLines: [{ start: 1, end: changedEnd }],
  }];
  const projectFiles: ProjectFile[] = [
    { filePath: "src/api.ts", source: after },
    { filePath: "src/handler.ts", source: staleCaller },
  ];
  return { changes, projectFiles };
}

describe("contract narrowing after ship evidence", () => {
  it("flags a new required options field with a caller that omits it", () => {
    const { changes, projectFiles } = scenario(afterRequired, 7);
    const evidence = buildContractNarrowingEvidence(
      candidate("src/api.ts"),
      changes,
      projectFiles,
    );

    expect(evidence).toMatchObject({
      anchorFile: "src/api.ts",
      narrowings: [{ kind: "required-property", target: "ListOptions.tenant" }],
    });
    expect(evidence?.affectedCallers).toEqual([
      expect.objectContaining({
        filePath: "src/handler.ts",
        target: "listUsers",
        omitsNarrowedInput: true,
      }),
    ]);
  });

  it("abstains when the new field stays optional", () => {
    const { changes, projectFiles } = scenario(afterOptional, 7);

    expect(buildContractNarrowingEvidence(
      candidate("src/api.ts"),
      changes,
      projectFiles,
    )).toBeUndefined();
  });

  it("abstains for a new positional parameter, which belongs to export-reshape", () => {
    const { changes, projectFiles } = scenario(afterPositional, 7);

    expect(buildContractNarrowingEvidence(
      candidate("src/api.ts"),
      changes,
      projectFiles,
    )).toBeUndefined();
  });
});
