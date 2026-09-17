import { readFile } from "node:fs/promises";
import { describe, expect, it } from "vitest";
import { extractCandidates } from "../src/candidates.js";
import { buildHardcodedConfigShadowEvidence } from "../src/evidence/hardcoded-config-shadow.js";
import type { ProjectFile } from "../src/types.js";

async function project(name: string, paths: string[]): Promise<ProjectFile[]> {
  return Promise.all(paths.map(async (filePath) => ({
    filePath,
    source: await readFile(
      new URL(`./fixtures/repositories/${name}/${filePath}`, import.meta.url),
      "utf8",
    ),
  })));
}

function candidateFor(files: ProjectFile[], filePath: string, marker: string) {
  const file = files.find((entry) => entry.filePath === filePath);
  expect(file).toBeDefined();
  if (!file) return undefined;
  const candidate = extractCandidates(file.filePath, file.source)
    .find(({ source }) => source.includes(marker));
  expect(candidate).toBeDefined();
  return candidate;
}

describe("hardcoded config shadow evidence", () => {
  it("shows Jev the literal next to the repository config source", async () => {
    const files = await project("hardcoded-config-shadow-positive", [
      "src/upload.ts",
      "src/settings.ts",
      "src/caller.ts",
    ]);
    const candidate = candidateFor(files, "src/upload.ts", "checkUploadSize");
    if (!candidate) return;

    const evidence = buildHardcodedConfigShadowEvidence(candidate, files);

    expect(evidence).toMatchObject({
      function: {
        name: "checkUploadSize",
        exported: true,
        source: expect.stringContaining("maxSizeKB"),
      },
      literals: [
        { kind: "named-limit", expression: expect.stringContaining("10 * 1024") },
      ],
      configSources: [
        { filePath: "src/settings.ts", excerpt: expect.stringContaining("SiteSettings") },
      ],
      callers: [{ filePath: "src/caller.ts" }],
    });
  });

  it("abstains when the function reads config instead of restating it", async () => {
    const files = await project("hardcoded-config-shadow-negative", [
      "src/upload.ts",
      "src/settings.ts",
    ]);
    const candidate = candidateFor(files, "src/upload.ts", "checkUploadSize");
    if (!candidate) return;

    expect(buildHardcodedConfigShadowEvidence(candidate, files)).toBeUndefined();
  });

  it("abstains when the repository owns no config source", () => {
    const source = `export function checkUploadSize(fileSizeKB: number): boolean {
      const maxSizeKB = 10 * 1024;
      return fileSizeKB <= maxSizeKB;
    }`;
    const candidate = extractCandidates("src/upload.ts", source)[0];
    expect(candidate).toBeDefined();
    if (!candidate) return;

    expect(buildHardcodedConfigShadowEvidence(candidate, [{ filePath: "src/upload.ts", source }]))
      .toBeUndefined();
  });
});
