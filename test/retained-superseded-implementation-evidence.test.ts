import { readFile } from "node:fs/promises";
import { describe, expect, it } from "vitest";
import { extractCandidates } from "../src/candidates.js";
import { buildRetainedSupersededImplementationEvidence } from "../src/evidence/retained-superseded-implementation.js";
import type { ProjectFile } from "../src/types.js";

const repositories = new URL("./fixtures/repositories/", import.meta.url);

async function project(name: string, paths: string[]): Promise<ProjectFile[]> {
  return Promise.all(paths.map(async (filePath) => ({
    filePath,
    source: await readFile(new URL(`${name}/${filePath}`, repositories), "utf8"),
  })));
}

describe("retained superseded implementation evidence", () => {
  it("reports a marked, callerless implementation beside its in-use successor", async () => {
    const projectFiles = await project("superseded-retained", [
      "src/legacy.ts",
      "src/format.ts",
    ]);
    const owner = projectFiles[0];
    expect(owner).toBeDefined();
    if (!owner) return;
    const candidate = extractCandidates(owner.filePath, owner.source)
      .find(({ kind, source }) => kind === "function" && source.includes("formatUserLegacy"));
    expect(candidate).toBeDefined();
    if (!candidate) return;

    const evidence = buildRetainedSupersededImplementationEvidence(candidate, projectFiles);

    expect(evidence).toMatchObject({
      function: { name: "formatUserLegacy", exported: true, filePath: "src/legacy.ts" },
      marker: {
        tag: "@deprecated",
        note: expect.stringContaining("@deprecated"),
        successor: "formatUserDisplay",
      },
      callerCount: 0,
      successor: {
        name: "formatUserDisplay",
        useCount: 1,
        files: ["src/format.ts"],
      },
    });
  });

  it("abstains when the marked implementation still has callers", async () => {
    const projectFiles: ProjectFile[] = [
      {
        filePath: "src/legacy.ts",
        source: "/** @deprecated use formatUserDisplay instead */\n"
          + "export function formatUserLegacy(name: string): string {\n"
          + "  return name.trim();\n"
          + "}\n",
      },
      {
        filePath: "src/app.ts",
        source: "import { formatUserLegacy } from \"./legacy.js\";\n"
          + "export function label(name: string): string {\n"
          + "  return formatUserLegacy(name);\n"
          + "}\n",
      },
      {
        filePath: "src/format.ts",
        source: "export function formatUserDisplay(name: string): string {\n"
          + "  return name.trim().toLowerCase();\n"
          + "}\n",
      },
    ];
    const candidate = extractCandidates(projectFiles[0]!.filePath, projectFiles[0]!.source)
      .find(({ kind, source }) => kind === "function" && source.includes("formatUserLegacy"));
    expect(candidate).toBeDefined();
    if (!candidate) return;

    expect(buildRetainedSupersededImplementationEvidence(candidate, projectFiles)).toBeUndefined();
  });

  it("abstains when no supersede marker is present", async () => {
    const projectFiles: ProjectFile[] = [
      {
        filePath: "src/legacy.ts",
        source: "export function formatUserLegacy(name: string): string {\n"
          + "  return name.trim();\n"
          + "}\n",
      },
    ];
    const candidate = extractCandidates(projectFiles[0]!.filePath, projectFiles[0]!.source)
      .find(({ kind, source }) => kind === "function" && source.includes("formatUserLegacy"));
    expect(candidate).toBeDefined();
    if (!candidate) return;

    expect(buildRetainedSupersededImplementationEvidence(candidate, projectFiles)).toBeUndefined();
  });
});
