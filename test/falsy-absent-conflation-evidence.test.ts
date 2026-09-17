import { readFile } from "node:fs/promises";
import { describe, expect, it } from "vitest";
import { extractCandidates } from "../src/candidates.js";
import { buildFalsyAbsentConflationEvidence } from "../src/evidence/falsy-absent-conflation.js";
import type { ProjectFile } from "../src/types.js";

const repositories = new URL("./fixtures/repositories/", import.meta.url);

async function project(name: string, paths: string[]): Promise<ProjectFile[]> {
  return Promise.all(paths.map(async (filePath) => ({
    filePath,
    source: await readFile(new URL(`${name}/${filePath}`, repositories), "utf8"),
  })));
}

describe("falsy absent conflation evidence", () => {
  it("extracts truthiness checks, declared types, and callers", async () => {
    const projectFiles = await project("falsy-absent-positive", [
      "src/sampling.ts",
      "src/schema.ts",
      "src/app.ts",
    ]);
    const owner = projectFiles[0];
    expect(owner).toBeDefined();
    if (!owner) return;
    const candidate = extractCandidates(owner.filePath, owner.source)
      .find(({ source }) => source.includes("function effectiveSampleRate"));
    expect(candidate).toBeDefined();
    if (!candidate) return;

    const evidence = buildFalsyAbsentConflationEvidence(candidate, projectFiles);

    expect(evidence).toMatchObject({
      function: { name: "effectiveSampleRate", exported: true },
      checks: [{
        kind: "if",
        tested: expect.stringContaining("sampleRate"),
        usesNullish: false,
      }],
      repository: {
        callers: [expect.objectContaining({ filePath: "src/app.ts" })],
        relatedModules: [expect.objectContaining({ filePath: "src/schema.ts" })],
      },
    });
  });

  it("still surfaces a truthiness check where falsy is invalid upstream", async () => {
    const projectFiles = await project("falsy-absent-negative", [
      "src/sampling.ts",
      "src/schema.ts",
      "src/app.ts",
    ]);
    const owner = projectFiles[0];
    expect(owner).toBeDefined();
    if (!owner) return;
    const candidate = extractCandidates(owner.filePath, owner.source)
      .find(({ source }) => source.includes("function displayLabel"));
    expect(candidate).toBeDefined();
    if (!candidate) return;

    expect(buildFalsyAbsentConflationEvidence(candidate, projectFiles)).toMatchObject({
      checks: [{ kind: "if", tested: expect.stringContaining("label") }],
    });
  });

  it("abstains when absence is tested explicitly", () => {
    const source = `
      export function rate(input: number | undefined): number {
        if (input !== undefined) return input;
        return 1;
      }
    `;
    const candidate = extractCandidates("src/rate.ts", source)[0];
    expect(candidate).toBeDefined();
    if (!candidate) return;

    expect(buildFalsyAbsentConflationEvidence(
      candidate,
      [{ filePath: "src/rate.ts", source }],
    )).toBeUndefined();
  });

  it("flags an || default as an or-default site", () => {
    const source = `
      export function timeout(input: number | undefined): number {
        return input || 5000;
      }
    `;
    const candidate = extractCandidates("src/timeout.ts", source)[0];
    expect(candidate).toBeDefined();
    if (!candidate) return;

    expect(buildFalsyAbsentConflationEvidence(
      candidate,
      [{ filePath: "src/timeout.ts", source }],
    )).toMatchObject({
      checks: [{ kind: "or-default", tested: "input" }],
    });
  });
});
