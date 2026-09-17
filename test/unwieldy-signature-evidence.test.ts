import { readFile } from "node:fs/promises";
import { describe, expect, it } from "vitest";
import { extractCandidates } from "../src/candidates.js";
import { buildUnwieldySignatureEvidence } from "../src/evidence/unwieldy-signature.js";
import type { ProjectFile } from "../src/types.js";

const root = new URL("./fixtures/repositories/unwieldy-signature-smelly/", import.meta.url);

async function load(filePath: string): Promise<ProjectFile> {
  return { filePath, source: await readFile(new URL(filePath, root), "utf8") };
}

describe("unwieldy signature evidence", () => {
  it("classifies parameters and shows placeholder call shapes", async () => {
    const projectFiles = await Promise.all([
      "src/update-user.ts",
      "src/admin.ts",
    ].map(load));
    const owner = projectFiles[0];
    expect(owner).toBeDefined();
    if (!owner) return;
    const candidate = extractCandidates(owner.filePath, owner.source)
      .find(({ source }) => source.includes("function updateUser"));
    expect(candidate).toBeDefined();
    if (!candidate) return;

    const evidence = buildUnwieldySignatureEvidence(candidate, projectFiles);

    expect(evidence).toMatchObject({
      function: {
        name: "updateUser",
        exported: true,
        source: expect.stringContaining("function updateUser"),
      },
      signature: {
        totalParameters: 7,
        positional: ["id", "actorId", "data", "cache", "notify", "force", "retries"],
        optionsBag: null,
        booleanParameters: ["notify", "force"],
        unreferencedParameters: ["cache", "retries"],
        overloads: [],
      },
      callSummary: {
        total: 2,
        withUndefinedPlaceholder: 2,
        distinctArgumentCounts: [7],
      },
    });
    expect(evidence?.callers.map(({ filePath }) => filePath)).toEqual([
      "src/admin.ts",
      "src/admin.ts",
    ]);
  });

  it("shows a usable signature without placeholders", async () => {
    const projectFiles = await Promise.all([
      "src/update-user.ts",
      "src/admin.ts",
    ].map(load));
    const owner = projectFiles[0];
    expect(owner).toBeDefined();
    if (!owner) return;
    const candidate = extractCandidates(owner.filePath, owner.source)
      .find(({ source }) => source.includes("function renameUser"));
    expect(candidate).toBeDefined();
    if (!candidate) return;

    expect(buildUnwieldySignatureEvidence(candidate, projectFiles)).toMatchObject({
      function: { name: "renameUser" },
      signature: {
        totalParameters: 2,
        booleanParameters: [],
        unreferencedParameters: [],
      },
      callSummary: {
        total: 1,
        withUndefinedPlaceholder: 0,
      },
    });
  });

  it("abstains when there is no signature to judge", async () => {
    const projectFiles = await Promise.all([
      "src/update-user.ts",
      "src/admin.ts",
    ].map(load));
    const owner = projectFiles[0];
    expect(owner).toBeDefined();
    if (!owner) return;
    const candidate = extractCandidates(owner.filePath, owner.source)
      .find(({ source }) => source.includes("function noArguments"));
    expect(candidate).toBeDefined();
    if (!candidate) return;

    expect(buildUnwieldySignatureEvidence(candidate, projectFiles)).toBeUndefined();
  });
});
