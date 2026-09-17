import { readFile } from "node:fs/promises";
import { describe, expect, it } from "vitest";
import { extractCandidates } from "../src/candidates.js";
import { buildSingleCallerExportedHelperEvidence } from "../src/evidence/single-caller-exported-helper.js";
import type { ProjectFile } from "../src/types.js";

const root = new URL("./fixtures/repositories/single-caller-smelly/", import.meta.url);

async function load(filePath: string): Promise<ProjectFile> {
  return { filePath, source: await readFile(new URL(filePath, root), "utf8") };
}

describe("single caller exported helper evidence", () => {
  it("shows the lone caller, its ownership, and the absence of re-export", async () => {
    const projectFiles = await Promise.all([
      "src/format.ts",
      "src/cart.ts",
    ].map(load));
    const owner = projectFiles[0];
    expect(owner).toBeDefined();
    if (!owner) return;
    const candidate = extractCandidates(owner.filePath, owner.source)[0];
    expect(candidate).toBeDefined();
    if (!candidate) return;

    const evidence = buildSingleCallerExportedHelperEvidence(candidate, projectFiles);

    expect(evidence).toMatchObject({
      function: { name: "formatCents", exported: true },
      totalCallers: 1,
      caller: expect.objectContaining({ filePath: "src/format.ts" }),
      callerOwnership: "same-file",
      reexport: { reexported: false, reexportPaths: [] },
    });
  });

  it("abstains when a second caller demonstrates reuse", async () => {
    const shared = new URL("./fixtures/repositories/single-caller-shared/", import.meta.url);
    const projectFiles = await Promise.all([
      "src/format.ts",
      "src/cart.ts",
    ].map(async (filePath): Promise<ProjectFile> => ({
      filePath,
      source: await readFile(new URL(filePath, shared), "utf8"),
    })));
    const owner = projectFiles[0];
    expect(owner).toBeDefined();
    if (!owner) return;
    const candidate = extractCandidates(owner.filePath, owner.source)[0];
    expect(candidate).toBeDefined();
    if (!candidate) return;

    expect(buildSingleCallerExportedHelperEvidence(candidate, projectFiles))
      .toBeUndefined();
  });

  it("abstains for an unexported helper", () => {
    const source = [
      "function cents(cents: number) { return cents / 100; }",
      "export function label(total: number) { return `${cents(total)}`; }",
    ].join("\n");
    const candidate = extractCandidates("src/format.ts", source)
      .find(({ source }) => source.includes("function cents"));
    expect(candidate).toBeDefined();
    if (!candidate) return;

    expect(buildSingleCallerExportedHelperEvidence(candidate, [{ filePath: "src/format.ts", source }]))
      .toBeUndefined();
  });
});
