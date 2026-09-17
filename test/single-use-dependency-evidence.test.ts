import { readFile } from "node:fs/promises";
import { describe, expect, it } from "vitest";
import { buildSingleUseDependencyEvidence } from "../src/evidence/single-use-dependency.js";
import type { Candidate, ProjectFile, SourceFile } from "../src/types.js";

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

function manifestChange(filePath: string, source: string, oldSource: string): SourceFile {
  return { filePath, source, oldSource, changedLines: [{ start: 1, end: 8 }] };
}

describe("single use dependency evidence", () => {
  it("flags an added dependency with one trivial call site", async () => {
    const projectFiles = await project("single-use-positive", [
      "package.json",
      "src/id.ts",
    ]);
    const manifest = projectFiles.find((file) => file.filePath === "package.json");
    expect(manifest).toBeDefined();
    if (!manifest) return;
    const oldSource = JSON.stringify({ name: "single-use-positive", version: "1.0.0", dependencies: {} });

    const evidence = buildSingleUseDependencyEvidence(
      changeCandidate("package.json"),
      projectFiles,
      [manifestChange("package.json", manifest.source, oldSource)],
    );
    expect(evidence).toMatchObject({
      manifest: { filePath: "package.json", addedDependencies: ["uuid"] },
      added: [
        {
          name: "uuid",
          importSites: ["src/id.ts"],
          platformEquivalent: "crypto.randomUUID()",
        },
      ],
    });
    expect(evidence?.added[0]?.usedMembers).toEqual([]);
    expect(evidence?.added[0]?.importLines).toEqual([expect.stringContaining('from "uuid"')]);
  });

  it("leaves a broadly used dependency alone", async () => {
    const projectFiles = await project("single-use-negative", [
      "package.json",
      "src/schemas.ts",
      "src/parse.ts",
      "src/count.ts",
    ]);
    const manifest = projectFiles.find((file) => file.filePath === "package.json");
    expect(manifest).toBeDefined();
    if (!manifest) return;
    const oldSource = JSON.stringify({ name: "single-use-negative", version: "1.0.0", dependencies: {} });

    const evidence = buildSingleUseDependencyEvidence(
      changeCandidate("package.json"),
      projectFiles,
      [manifestChange("package.json", manifest.source, oldSource)],
    );
    expect(evidence?.added[0]?.importSites).toHaveLength(3);
  });

  it("abstains when no manifest changes", async () => {
    const projectFiles = await project("single-use-positive", [
      "package.json",
      "src/id.ts",
    ]);
    expect(
      buildSingleUseDependencyEvidence(changeCandidate("src/id.ts"), projectFiles, []),
    ).toBeUndefined();
  });
});
