import { describe, expect, it } from "vitest";
import { buildChangeAmplifierCaseEvidence } from "../src/evidence/change-amplifier-case.js";
import type { Candidate, ProjectFile, SourceFile } from "../src/types.js";

const beforeTypes = `export type Status = "active" | "paused";
`;

const afterTypes = `export type Status = "active" | "paused" | "archived";
`;

const renderer = `import type { Status } from "./types";
export function renderBadge(status: Status): string {
  switch (status) {
    case "active": return "on";
    case "paused": return "hold";
    default: return "off";
  }
}
`;

const reporter = `import type { Status } from "./types";
export function reportName(status: Status): string {
  switch (status) {
    case "active": return "Active";
    case "paused": return "Paused";
    default: return "Other";
  }
}
`;

const exhaustiveRenderer = `import type { Status } from "./types";
function assertNever(value: never): never {
  throw new Error(\`unhandled: \${String(value)}\`);
}
export function renderBadge(status: Status): string {
  switch (status) {
    case "active": return "on";
    case "paused": return "hold";
    default: return assertNever(status);
  }
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

function scenario(after: string, mirrors: ProjectFile[]): ChangeScenario {
  const changes: SourceFile[] = [{
    filePath: "src/types.ts",
    source: after,
    oldSource: beforeTypes,
    changedLines: [{ start: 1, end: 1 }],
  }];
  const projectFiles: ProjectFile[] = [
    { filePath: "src/types.ts", source: after },
    ...mirrors,
  ];
  return { changes, projectFiles };
}

describe("change amplifier case evidence", () => {
  it("flags a new union member with mirrors that do not handle it", () => {
    const { changes, projectFiles } = scenario(afterTypes, [
      { filePath: "src/renderer.ts", source: renderer },
      { filePath: "src/reporter.ts", source: reporter },
    ]);
    const evidence = buildChangeAmplifierCaseEvidence(
      candidate("src/types.ts"),
      changes,
      projectFiles,
    );

    expect(evidence).toMatchObject({
      anchorFile: "src/types.ts",
      addedCases: [{ kind: "union-member", literal: "archived" }],
    });
    expect(evidence?.mirrors.length).toBeGreaterThanOrEqual(2);
    expect(evidence?.mirrors.every(({ handlesAdded }) => handlesAdded === false)).toBe(true);
    expect(evidence?.mirrors.every(({ exhaustive }) => exhaustive === false)).toBe(true);
  });

  it("marks mirrors with an exhaustiveness check as exhaustive", () => {
    const { changes, projectFiles } = scenario(afterTypes, [
      { filePath: "src/renderer.ts", source: exhaustiveRenderer },
    ]);
    const evidence = buildChangeAmplifierCaseEvidence(
      candidate("src/types.ts"),
      changes,
      projectFiles,
    );

    expect(evidence?.mirrors).toHaveLength(1);
    expect(evidence?.mirrors[0]).toMatchObject({ exhaustive: true, handlesAdded: false });
  });

  it("abstains when no sibling code branches over the widened set", () => {
    const { changes, projectFiles } = scenario(afterTypes, [
      { filePath: "src/unrelated.ts", source: "export const version = 1;\n" },
    ]);

    expect(buildChangeAmplifierCaseEvidence(
      candidate("src/types.ts"),
      changes,
      projectFiles,
    )).toBeUndefined();
  });

  it("abstains when the change adds no case", () => {
    const { changes, projectFiles } = scenario(beforeTypes, [
      { filePath: "src/renderer.ts", source: renderer },
    ]);

    expect(buildChangeAmplifierCaseEvidence(
      candidate("src/types.ts"),
      changes,
      projectFiles,
    )).toBeUndefined();
  });
});
