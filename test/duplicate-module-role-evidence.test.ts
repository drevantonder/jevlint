import { describe, expect, it } from "vitest";
import { buildDuplicateModuleRoleEvidence } from "../src/evidence/duplicate-module-role.js";
import type { Candidate, ProjectFile, SourceFile } from "../src/types.js";

const newClient = `export function get(url: string) {
  return fetch(url);
}
export function post(url: string, body: unknown) {
  return fetch(url, { method: "POST", body: JSON.stringify(body) });
}
`;

const twinClient = `export function get(url: string) {
  return fetch(url);
}
export function post(url: string, body: unknown) {
  return fetch(url, { method: "POST", body: JSON.stringify(body) });
}
`;

const unrelated = `export function totals(lines: number[]) {
  return lines.reduce((sum, line) => sum + line, 0);
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

function scenario(siblingSource: string, siblingPath = "src/api-client.ts"): Scenario {
  const changes: SourceFile[] = [{
    filePath: "src/http-client.ts",
    source: newClient,
    oldSource: null,
    changedLines: [{ start: 1, end: 6 }],
  }];
  const projectFiles: ProjectFile[] = [
    { filePath: "src/http-client.ts", source: newClient },
    { filePath: siblingPath, source: siblingSource },
  ];
  return { changes, projectFiles };
}

describe("duplicate module role evidence", () => {
  it("reports a new file sharing exports with a same-directory twin", () => {
    const { changes, projectFiles } = scenario(twinClient);
    const evidence = buildDuplicateModuleRoleEvidence(
      candidate("src/http-client.ts"),
      changes,
      projectFiles,
    );

    expect(evidence).toMatchObject({
      newFile: "src/http-client.ts",
      newExports: ["get", "post"],
    });
    expect(evidence?.twins.map(({ filePath }) => filePath)).toContain("src/api-client.ts");
    expect(evidence?.twins[0]).toMatchObject({
      sharedExportNames: ["get", "post"],
      platformVariant: false,
    });
    expect(evidence?.twins[0]?.nameSimilarity).toBeGreaterThan(0);
  });

  it("marks platform variants instead of hiding them", () => {
    const { changes, projectFiles } = scenario(twinClient, "src/http-client.ios.ts");
    const evidence = buildDuplicateModuleRoleEvidence(
      candidate("src/http-client.ts"),
      changes,
      projectFiles,
    );

    expect(evidence?.twins[0]).toMatchObject({ platformVariant: true });
  });

  it("abstains when the change edits rather than adds the file", () => {
    const changes: SourceFile[] = [{
      filePath: "src/http-client.ts",
      source: newClient,
      oldSource: twinClient,
      changedLines: [{ start: 1, end: 6 }],
    }];
    const projectFiles: ProjectFile[] = [
      { filePath: "src/http-client.ts", source: newClient },
      { filePath: "src/api-client.ts", source: twinClient },
    ];
    expect(buildDuplicateModuleRoleEvidence(
      candidate("src/http-client.ts"),
      changes,
      projectFiles,
    )).toBeUndefined();
  });

  it("abstains when no sibling shares exports or name tokens", () => {
    const { changes, projectFiles } = scenario(unrelated, "src/totals.ts");
    expect(buildDuplicateModuleRoleEvidence(
      candidate("src/http-client.ts"),
      changes,
      projectFiles,
    )).toBeUndefined();
  });
});
