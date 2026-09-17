import { readFile } from "node:fs/promises";
import { describe, expect, it } from "vitest";
import { extractCandidates } from "../src/candidates.js";
import { buildSpeculativeGeneralityEvidence } from "../src/evidence/speculative-generality.js";
import type { ProjectFile } from "../src/types.js";

const root = new URL("./fixtures/repositories/speculative-generality-smelly/", import.meta.url);

async function load(filePath: string): Promise<ProjectFile> {
  return { filePath, source: await readFile(new URL(filePath, root), "utf8") };
}

describe("speculative generality evidence", () => {
  it("shows declared flexibility beside how callers actually use it", async () => {
    const projectFiles = await Promise.all([
      "src/format-user-name.ts",
      "src/profile.ts",
      "src/audit.ts",
    ].map(load));
    const owner = projectFiles[0];
    expect(owner).toBeDefined();
    if (!owner) return;
    const candidate = extractCandidates(owner.filePath, owner.source)
      .find(({ source }) => source.includes("function formatUserName"));
    expect(candidate).toBeDefined();
    if (!candidate) return;

    const evidence = buildSpeculativeGeneralityEvidence(candidate, projectFiles);

    expect(evidence).toMatchObject({
      function: {
        name: "formatUserName",
        exported: true,
        moduleSource: expect.stringContaining("interface FormatOptions"),
      },
      extensionSignals: expect.arrayContaining([
        expect.stringContaining("options"),
      ]),
      callers: [
        expect.objectContaining({ filePath: "src/profile.ts", arguments: ["user"] }),
        expect.objectContaining({ filePath: "src/audit.ts", arguments: ["user"] }),
      ],
      observedArgumentLists: [["user"]],
    });
  });

  it("abstains when a function exposes no extension mechanism", () => {
    const source = "export function fullName(first: string, last: string) { return `${first} ${last}`; }";
    const candidate = extractCandidates("src/name.ts", source)[0];
    expect(candidate).toBeDefined();
    if (!candidate) return;

    expect(buildSpeculativeGeneralityEvidence(candidate, [{ filePath: "src/name.ts", source }]))
      .toBeUndefined();
  });
});
