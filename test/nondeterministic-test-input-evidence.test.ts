import { readFile } from "node:fs/promises";
import { describe, expect, it } from "vitest";
import { extractCandidates } from "../src/candidates.js";
import { buildNondeterministicTestInputEvidence } from "../src/evidence/nondeterministic-test-input.js";
import type { ProjectFile } from "../src/types.js";

const repositories = new URL("./fixtures/repositories/", import.meta.url);

async function project(name: string, paths: string[]): Promise<ProjectFile[]> {
  return Promise.all(paths.map(async (filePath) => ({
    filePath,
    source: await readFile(new URL(`${name}/${filePath}`, repositories), "utf8"),
  })));
}

function testCandidate(owner: ProjectFile, snippet: string) {
  return extractCandidates(owner.filePath, owner.source)
    .filter(({ kind, source }) => kind === "function" && source.includes(snippet))
    .sort((left, right) => left.source.length - right.source.length)[0];
}

describe("nondeterministic test input evidence", () => {
  it("flags unseeded randomness and live time feeding a snapshot", async () => {
    const projectFiles = await project("nondeterministic-positive", ["test/pricing.test.ts"]);
    const owner = projectFiles[0];
    expect(owner).toBeDefined();
    if (!owner) return;
    const candidate = testCandidate(owner, "Math.random");
    expect(candidate).toBeDefined();
    if (!candidate) return;

    expect(buildNondeterministicTestInputEvidence(candidate, projectFiles)).toMatchObject({
      reads: expect.arrayContaining([
        expect.objectContaining({ kind: "math-random" }),
        expect.objectContaining({ kind: "date-now" }),
      ]),
      seededPrng: false,
      fakeTimers: false,
    });
  });

  it("records seeded draws and fake timers as mitigating context", async () => {
    const projectFiles = await project("nondeterministic-seeded", ["test/pricing.test.ts"]);
    const owner = projectFiles[0];
    expect(owner).toBeDefined();
    if (!owner) return;
    const candidate = testCandidate(owner, "priceWithDiscount(100, lucky");
    expect(candidate).toBeDefined();
    if (!candidate) return;

    expect(buildNondeterministicTestInputEvidence(candidate, projectFiles)).toMatchObject({
      reads: expect.arrayContaining([expect.objectContaining({ kind: "math-random" })]),
      seededPrng: true,
      fakeTimers: true,
    });
  });

  it("abstains when the test uses only fixed inputs", async () => {
    const projectFiles = await project("nondeterministic-negative", ["test/pricing.test.ts"]);
    const owner = projectFiles[0];
    expect(owner).toBeDefined();
    if (!owner) return;
    const candidate = testCandidate(owner, "priceWithDiscount(100, 0.5");
    expect(candidate).toBeDefined();
    if (!candidate) return;

    expect(buildNondeterministicTestInputEvidence(candidate, projectFiles)).toBeUndefined();
  });
});
