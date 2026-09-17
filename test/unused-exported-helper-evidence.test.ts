import { readFile } from "node:fs/promises";
import { describe, expect, it } from "vitest";
import { extractCandidates } from "../src/candidates.js";
import { buildUnusedExportedHelperEvidence } from "../src/evidence/unused-exported-helper.js";
import type { ProjectFile } from "../src/types.js";

const repositories = new URL("./fixtures/repositories/", import.meta.url);

async function project(name: string, paths: string[]): Promise<ProjectFile[]> {
  return Promise.all(paths.map(async (filePath) => ({
    filePath,
    source: await readFile(new URL(`${name}/${filePath}`, repositories), "utf8"),
  })));
}

function functionCandidate(source: string, filePath: string, snippet: string) {
  const candidate = extractCandidates(filePath, source)
    .find(({ kind, source: text }) => kind === "function" && text.includes(snippet));
  expect(candidate).toBeDefined();
  if (!candidate) throw new Error("missing candidate");
  return candidate;
}

describe("unused exported helper evidence", () => {
  it("reports a zero-caller export with no importers and no re-export", async () => {
    const projectFiles = await project("unused-export-dead", [
      "src/totals.ts",
      "src/app.ts",
    ]);
    const owner = projectFiles[0];
    expect(owner).toBeDefined();
    if (!owner) return;

    const evidence = buildUnusedExportedHelperEvidence(
      functionCandidate(owner.source, owner.filePath, "orphanTotal"),
      projectFiles,
    );

    expect(evidence).toMatchObject({
      function: { name: "orphanTotal", exported: true, filePath: "src/totals.ts" },
      callerCount: 0,
      callerExcerpts: [],
      symbolImporters: [],
      reexport: { reexported: false, reexportPaths: [] },
      textualLeads: [],
    });
  });

  it("surfaces the barrel re-export path as a liveness signal", async () => {
    const projectFiles = await project("unused-export-barrel", [
      "src/totals.ts",
      "src/index.ts",
    ]);
    const owner = projectFiles[0];
    expect(owner).toBeDefined();
    if (!owner) return;

    const evidence = buildUnusedExportedHelperEvidence(
      functionCandidate(owner.source, owner.filePath, "orphanTotal"),
      projectFiles,
    );

    expect(evidence).toMatchObject({
      callerCount: 0,
      reexport: { reexported: true, reexportPaths: ["src/index.ts"] },
    });
  });

  it("abstains when the export has a live caller", async () => {
    const projectFiles = await project("unused-export-dead", [
      "src/totals.ts",
      "src/app.ts",
    ]);
    const owner = projectFiles[0];
    expect(owner).toBeDefined();
    if (!owner) return;

    expect(buildUnusedExportedHelperEvidence(
      functionCandidate(owner.source, owner.filePath, "liveTotal"),
      projectFiles,
    )).toBeUndefined();
  });

  it("abstains for an unexported zero-caller function", () => {
    const source = "function orphan(items: number[]) { return items.length; }\n"
      + "export function live(items: number[]) { return items.length; }\n";
    const candidate = functionCandidate(source, "src/totals.ts", "function orphan");

    expect(buildUnusedExportedHelperEvidence(candidate, [{ filePath: "src/totals.ts", source }]))
      .toBeUndefined();
  });

  it("abstains for a marked implementation owned by the superseded rule", () => {
    const source = "/** @deprecated use liveTotal instead */\n"
      + "export function orphanTotal(items: number[]): number {\n"
      + "  return items.length;\n"
      + "}\n";
    const candidate = functionCandidate(source, "src/totals.ts", "orphanTotal");

    expect(buildUnusedExportedHelperEvidence(candidate, [{ filePath: "src/totals.ts", source }]))
      .toBeUndefined();
  });
});
