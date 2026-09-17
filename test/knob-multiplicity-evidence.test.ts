import { readFile } from "node:fs/promises";
import { describe, expect, it } from "vitest";
import { extractCandidates } from "../src/candidates.js";
import { buildKnobMultiplicityEvidence } from "../src/evidence/knob-multiplicity.js";
import type { ProjectFile } from "../src/types.js";

const root = new URL("./fixtures/repositories/knob-multiplicity-positive/", import.meta.url);
const negativeRoot = new URL("./fixtures/repositories/knob-multiplicity-negative/", import.meta.url);

async function load(base: URL, filePath: string): Promise<ProjectFile> {
  return { filePath, source: await readFile(new URL(filePath, base), "utf8") };
}

describe("knob multiplicity evidence", () => {
  it("collects three or more control mechanisms for one concept stem", async () => {
    const projectFiles = await Promise.all([
      "src/timeout-options.ts",
      "src/env.ts",
      "src/cli.ts",
      "src/client.ts",
    ].map((filePath) => load(root, filePath)));
    const owner = projectFiles[0];
    expect(owner).toBeDefined();
    if (!owner) return;
    const candidate = extractCandidates(owner.filePath, owner.source)
      .find(({ kind }) => kind === "abstraction");
    expect(candidate).toBeDefined();
    if (!candidate) return;

    const evidence = buildKnobMultiplicityEvidence(candidate, projectFiles);

    expect(evidence).toMatchObject({
      concept: {
        name: "TimeoutOptions",
        stem: "timeout",
        filePath: "src/timeout-options.ts",
      },
      mechanisms: expect.arrayContaining([
        expect.objectContaining({ kind: "env" }),
        expect.objectContaining({ kind: "cli" }),
        expect.objectContaining({ kind: "config" }),
        expect.objectContaining({ kind: "parameter" }),
      ]),
    });
    expect(evidence?.mechanisms.length).toBeGreaterThanOrEqual(3);
  });

  it("abstains when fewer than three mechanisms govern the concept", async () => {
    const projectFiles = await Promise.all([
      "src/retry-options.ts",
      "src/env.ts",
    ].map((filePath) => load(negativeRoot, filePath)));
    const owner = projectFiles[0];
    expect(owner).toBeDefined();
    if (!owner) return;
    const candidate = extractCandidates(owner.filePath, owner.source)
      .find(({ kind }) => kind === "abstraction");
    expect(candidate).toBeDefined();
    if (!candidate) return;

    expect(buildKnobMultiplicityEvidence(candidate, projectFiles)).toBeUndefined();
  });
});
