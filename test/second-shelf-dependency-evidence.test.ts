import { readFile } from "node:fs/promises";
import { describe, expect, it } from "vitest";
import { buildSecondShelfDependencyEvidence } from "../src/evidence/second-shelf-dependency.js";
import type { Candidate, ProjectFile } from "../src/types.js";

const repositories = new URL("./fixtures/repositories/", import.meta.url);

async function project(name: string, paths: string[]): Promise<ProjectFile[]> {
  return Promise.all(paths.map(async (filePath) => ({
    filePath,
    source: await readFile(new URL(`${name}/${filePath}`, repositories), "utf8"),
  })));
}

function changeCandidate(filePath: string): Candidate {
  return {
    id: "change_0",
    kind: "change",
    filePath,
    source: "Whole change across 2 files. Use the rule-specific before/after evidence and its coverage metadata.",
    start: 0,
    end: 10,
    startLine: 1,
    startColumn: 1,
    endLine: 5,
    endColumn: 1,
  };
}

describe("second shelf dependency evidence", () => {
  it("flags a new date library beside the incumbent", async () => {
    const projectFiles = await project("second-shelf-positive", [
      "src/report.ts",
      "src/ledger.ts",
      "package.json",
    ]);

    expect(
      buildSecondShelfDependencyEvidence(changeCandidate("src/report.ts"), projectFiles, []),
    ).toMatchObject({
      anchorFile: "src/report.ts",
      manifest: { filePath: "package.json" },
      duplications: [
        {
          imported: "date-fns",
          capability: "date",
          incumbents: ["dayjs"],
          siblingIncumbentFiles: ["src/ledger.ts"],
        },
      ],
    });
  });

  it("leaves a sole capability library alone", async () => {
    const projectFiles = await project("second-shelf-negative", [
      "src/report.ts",
      "package.json",
    ]);

    expect(
      buildSecondShelfDependencyEvidence(changeCandidate("src/report.ts"), projectFiles, []),
    ).toMatchObject({ duplications: [] });
  });

  it("abstains when the anchor imports no labeled capability", async () => {
    const anchor: ProjectFile = {
      filePath: "src/plain.ts",
      source: "export function double(value: number): number {\n  return value * 2;\n}\n",
    };
    expect(
      buildSecondShelfDependencyEvidence(changeCandidate("src/plain.ts"), [anchor], []),
    ).toBeUndefined();
  });
});
