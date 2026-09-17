import { readFile } from "node:fs/promises";
import { describe, expect, it } from "vitest";
import { extractCandidates } from "../src/candidates.js";
import { buildUnverifiedMockContractEvidence } from "../src/evidence/unverified-mock-contract.js";
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

describe("unverified mock contract evidence", () => {
  it("lists divergences when the stub disagrees with the real module", async () => {
    const projectFiles = await project("mock-contract-positive", [
      "test/client.test.ts",
      "src/api/client.ts",
    ]);
    const owner = projectFiles[0];
    expect(owner).toBeDefined();
    if (!owner) return;
    const candidate = testCandidate(owner, "await fetchUser");
    expect(candidate).toBeDefined();
    if (!candidate) return;

    const evidence = buildUnverifiedMockContractEvidence(candidate, projectFiles);
    expect(evidence).toMatchObject({
      mocks: [
        expect.objectContaining({
          resolvedFile: "src/api/client.ts",
          stubbedMembers: expect.arrayContaining(["fetchUser"]),
          absentMembers: [],
        }),
      ],
    });
    expect(evidence?.divergences.map(({ kind }) => kind)).toEqual(
      expect.arrayContaining(["return-key-mismatch", "unstubbed-error-path"]),
    );
  });

  it("returns empty divergences when the stub matches the real surface", async () => {
    const projectFiles = await project("mock-contract-negative", [
      "test/clock.test.ts",
      "src/clock.ts",
    ]);
    const owner = projectFiles[0];
    expect(owner).toBeDefined();
    if (!owner) return;
    const candidate = testCandidate(owner, "getFullYear");
    expect(candidate).toBeDefined();
    if (!candidate) return;

    expect(buildUnverifiedMockContractEvidence(candidate, projectFiles)).toMatchObject({
      mocks: [
        expect.objectContaining({
          resolvedFile: "src/clock.ts",
          absentMembers: [],
        }),
      ],
      divergences: [],
      checksComputedValue: true,
    });
  });

  it("abstains when no mock resolves to a project module", async () => {
    const projectFiles = await project("mock-contract-external", [
      "test/remote.test.ts",
    ]);
    const owner = projectFiles[0];
    expect(owner).toBeDefined();
    if (!owner) return;
    const candidate = testCandidate(owner, "statusCode");
    expect(candidate).toBeDefined();
    if (!candidate) return;

    expect(buildUnverifiedMockContractEvidence(candidate, projectFiles)).toBeUndefined();
  });
});
