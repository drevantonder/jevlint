import { readFile } from "node:fs/promises";
import { describe, expect, it } from "vitest";
import { extractCandidates } from "../src/candidates.js";
import { buildImplementationMirroredExpectationEvidence } from "../src/evidence/implementation-mirrored-expectation.js";
import type { ProjectFile } from "../src/types.js";

const repositories = new URL("./fixtures/repositories/", import.meta.url);

async function project(name: string, paths: string[]): Promise<ProjectFile[]> {
  return Promise.all(paths.map(async (filePath) => ({
    filePath,
    source: await readFile(new URL(`${name}/${filePath}`, repositories), "utf8"),
  })));
}

function testCandidate(owner: ProjectFile, needle: string) {
  return extractCandidates(owner.filePath, owner.source)
    .filter(({ kind, source }) => kind === "function" && source.includes(needle))
    .sort((left, right) => left.source.length - right.source.length)[0];
}

describe("implementation mirrored expectation evidence", () => {
  it("flags an expected literal found only in the subject and the test", async () => {
    const projectFiles = await project("mirrored-positive", [
      "test/errors.test.ts",
      "src/errors.ts",
      "src/other.ts",
    ]);
    const owner = projectFiles[0];
    expect(owner).toBeDefined();
    if (!owner) return;
    const candidate = testCandidate(owner, "ERR_RATE_V2");
    expect(candidate).toBeDefined();
    if (!candidate) return;

    expect(buildImplementationMirroredExpectationEvidence(candidate, projectFiles)).toMatchObject({
      subject: { filePath: "src/errors.ts" },
      mirrored: ["ERR_RATE_V2"],
    });
  });

  it("treats a literal anchored in fixtures and other consumers as independent", async () => {
    const projectFiles = await project("mirrored-negative", [
      "test/status.test.ts",
      "src/status.ts",
      "src/contract.ts",
      "src/other.ts",
    ]);
    const owner = projectFiles[0];
    expect(owner).toBeDefined();
    if (!owner) return;
    const candidate = testCandidate(owner, "ACTIVE_V1");
    expect(candidate).toBeDefined();
    if (!candidate) return;

    const evidence = buildImplementationMirroredExpectationEvidence(candidate, projectFiles);
    expect(evidence).toMatchObject({ mirrored: [] });
    expect(evidence?.expectations).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          literal: "ACTIVE_V1",
          inSubject: true,
          externalAnchors: expect.arrayContaining(["src/contract.ts", "src/other.ts"]),
        }),
      ]),
    );
  });

  it("abstains when assertions pin interactions rather than outcomes", async () => {
    const projectFiles = await project("mirrored-interaction", [
      "test/format.test.ts",
      "src/format.ts",
    ]);
    const owner = projectFiles[0];
    expect(owner).toBeDefined();
    if (!owner) return;
    const candidate = testCandidate(owner, "toHaveBeenCalledWith");
    expect(candidate).toBeDefined();
    if (!candidate) return;

    expect(buildImplementationMirroredExpectationEvidence(candidate, projectFiles)).toBeUndefined();
  });
});
