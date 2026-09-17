import { readFile } from "node:fs/promises";
import { describe, expect, it } from "vitest";
import { extractCandidates } from "../src/candidates.js";
import { buildAsymmetricNormalizationEvidence } from "../src/evidence/asymmetric-normalization.js";
import type { ProjectFile } from "../src/types.js";

const repositories = new URL("./fixtures/repositories/", import.meta.url);

async function project(name: string, paths: string[]): Promise<ProjectFile[]> {
  return Promise.all(paths.map(async (filePath) => ({
    filePath,
    source: await readFile(new URL(`${name}/${filePath}`, repositories), "utf8"),
  })));
}

describe("asymmetric normalization evidence", () => {
  it("extracts one-sided normalization, the normalizer, and callers", async () => {
    const projectFiles = await project("asymmetric-normalization-positive", [
      "src/blocklist.ts",
      "src/email-policy.ts",
      "src/signup.ts",
    ]);
    const owner = projectFiles[0];
    expect(owner).toBeDefined();
    if (!owner) return;
    const candidate = extractCandidates(owner.filePath, owner.source)
      .find(({ source }) => source.includes("function isBlocked"));
    expect(candidate).toBeDefined();
    if (!candidate) return;

    const evidence = buildAsymmetricNormalizationEvidence(candidate, projectFiles);

    expect(evidence).toMatchObject({
      function: { name: "isBlocked", exported: true },
      comparisons: [{
        operator: "includes",
        normalizedSide: "receiver",
        normalizer: "toLowerCase",
        source: expect.stringContaining("inputEmail"),
      }],
      repository: {
        callers: [expect.objectContaining({ filePath: "src/signup.ts" })],
        relatedModules: [expect.objectContaining({ filePath: "src/email-policy.ts" })],
      },
    });
  });

  it("marks both-sides-normalized comparisons as symmetric", async () => {
    const projectFiles = await project("asymmetric-normalization-negative", [
      "src/blocklist.ts",
      "src/email-policy.ts",
      "src/signup.ts",
    ]);
    const owner = projectFiles[0];
    expect(owner).toBeDefined();
    if (!owner) return;
    const candidate = extractCandidates(owner.filePath, owner.source)
      .find(({ source }) => source.includes("function isBlocked"));
    expect(candidate).toBeDefined();
    if (!candidate) return;

    expect(buildAsymmetricNormalizationEvidence(candidate, projectFiles)).toMatchObject({
      comparisons: [{ normalizedSide: "both", normalizer: "toLowerCase" }],
    });
  });

  it("abstains when neither comparison side normalizes", () => {
    const source = `
      export function isAllowed(role: string): boolean {
        return role === "admin";
      }
    `;
    const candidate = extractCandidates("src/role.ts", source)[0];
    expect(candidate).toBeDefined();
    if (!candidate) return;

    expect(buildAsymmetricNormalizationEvidence(
      candidate,
      [{ filePath: "src/role.ts", source }],
    )).toBeUndefined();
  });
});
