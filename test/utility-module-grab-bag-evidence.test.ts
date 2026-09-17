import { describe, expect, it } from "vitest";
import { buildUtilityModuleGrabBagEvidence } from "../src/evidence/utility-module-grab-bag.js";
import type { Candidate, ProjectFile, SourceFile } from "../src/types.js";

const beforeUtils = `export function formatDate(value: Date) {
  return value.toISOString();
}
export function retryHttp(url: string) {
  return fetch(url);
}
`;

const afterGrabBag = `${beforeUtils}export function parseCsv(text: string) {
  return text.split(",");
}
`;

const afterCohesive = `${beforeUtils}export function formatTime(value: Date) {
  return value.toTimeString();
}
`;

const dateCaller = `import { formatDate } from "./utils.js";
export function render(value: Date) {
  return formatDate(value);
}
`;

const httpCaller = `import { retryHttp } from "./utils.js";
export function sync(url: string) {
  return retryHttp(url);
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

type Scenario = { changes: SourceFile[]; projectFiles: ProjectFile[] };

function scenario(after: string): Scenario {
  const changes: SourceFile[] = [{
    filePath: "src/utils.ts",
    source: after,
    oldSource: beforeUtils,
    changedLines: [{ start: 7, end: 9 }],
  }];
  const projectFiles: ProjectFile[] = [
    { filePath: "src/utils.ts", source: after },
    { filePath: "src/render.ts", source: dateCaller },
    { filePath: "src/sync.ts", source: httpCaller },
  ];
  return { changes, projectFiles };
}

describe("utility module grab bag evidence", () => {
  it("reports a newcomer joining exports with disjoint importer footprints", () => {
    const { changes, projectFiles } = scenario(afterGrabBag);
    const evidence = buildUtilityModuleGrabBagEvidence(
      candidate("src/utils.ts"),
      changes,
      projectFiles,
    );

    expect(evidence).toMatchObject({
      moduleFile: "src/utils.ts",
      newExports: ["parseCsv"],
      existingExports: ["formatDate", "retryHttp"],
    });
    expect(evidence?.disjointImporterPairs).toBeGreaterThan(0);
    expect(evidence?.footprints.find(({ name }) => name === "formatDate")?.importerFiles)
      .toEqual(["src/render.ts"]);
  });

  it("still reports inventory when the newcomer is cohesive", () => {
    const { changes, projectFiles } = scenario(afterCohesive);
    const evidence = buildUtilityModuleGrabBagEvidence(
      candidate("src/utils.ts"),
      changes,
      projectFiles,
    );

    expect(evidence?.newExports).toEqual(["formatTime"]);
  });

  it("abstains outside shared utility paths", () => {
    const changes: SourceFile[] = [{
      filePath: "src/pricing.ts",
      source: `${beforeUtils}export function parseCsv(text: string) {\n  return text.split(",");\n}\n`,
      oldSource: beforeUtils,
      changedLines: [{ start: 7, end: 9 }],
    }];
    expect(buildUtilityModuleGrabBagEvidence(
      candidate("src/pricing.ts"),
      changes,
      [{ filePath: "src/pricing.ts", source: changes[0]!.source }],
    )).toBeUndefined();
  });
});
