import { readFile } from "node:fs/promises";
import { describe, expect, it } from "vitest";
import { extractCandidates } from "../src/candidates.js";
import {
  buildOwnedModuleMockEvidence,
  type OwnedModuleMockEvidence,
} from "../src/evidence/owned-module-mock.js";
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

/** Stand-in for Jev: maps evidence to a raw probability without any cutoff. */
function fakeScore(evidence: OwnedModuleMockEvidence | undefined): number | undefined {
  if (!evidence) return undefined;
  if (evidence.ownedMocks.some((mock) => !mock.adapterHint)) return 0.85;
  if (evidence.ownedMocks.length > 0) return 0.6;
  return 0.15;
}

describe("owned module mock evidence", () => {
  it("resolves an in-repo mock target to its repository file", async () => {
    const projectFiles = await project("owned-mock-positive", [
      "test/cart.test.ts",
      "src/cart.ts",
      "src/pricing.ts",
    ]);
    const owner = projectFiles[0];
    expect(owner).toBeDefined();
    if (!owner) return;
    const candidate = testCandidate(owner, "total(100, 2)");
    expect(candidate).toBeDefined();
    if (!candidate) return;

    const evidence = buildOwnedModuleMockEvidence(candidate, projectFiles);
    expect(evidence).toMatchObject({
      boundaryOnly: false,
      mocks: [
        expect.objectContaining({
          specifier: "../src/pricing.js",
          kind: "owned",
          resolvedFile: "src/pricing.ts",
          adapterHint: false,
        }),
      ],
      ownedMocks: [
        expect.objectContaining({
          specifier: "../src/pricing.js",
          resolvedFile: "src/pricing.ts",
        }),
      ],
    });
    expect(fakeScore(evidence)).toBe(0.85);
  });

  it("marks a node builtin mock as a system boundary", async () => {
    const projectFiles = await project("owned-mock-boundary", [
      "test/host.test.ts",
      "src/host.ts",
    ]);
    const owner = projectFiles[0];
    expect(owner).toBeDefined();
    if (!owner) return;
    const candidate = testCandidate(owner, 'toBe("host:test-host")');
    expect(candidate).toBeDefined();
    if (!candidate) return;

    const evidence = buildOwnedModuleMockEvidence(candidate, projectFiles);
    expect(evidence).toMatchObject({
      boundaryOnly: true,
      ownedMocks: [],
      mocks: [expect.objectContaining({ specifier: "node:os", kind: "boundary" })],
    });
    expect(fakeScore(evidence)).toBe(0.15);
  });

  it("records an unresolvable target without claiming ownership", async () => {
    const projectFiles = await project("owned-mock-unknown", [
      "test/cart.test.ts",
      "src/cart.ts",
      "src/pricing.ts",
    ]);
    const owner = projectFiles[0];
    expect(owner).toBeDefined();
    if (!owner) return;
    const candidate = testCandidate(owner, "total(100, 1)");
    expect(candidate).toBeDefined();
    if (!candidate) return;

    const evidence = buildOwnedModuleMockEvidence(candidate, projectFiles);
    expect(evidence).toMatchObject({
      boundaryOnly: true,
      ownedMocks: [],
      mocks: [expect.objectContaining({ specifier: "../src/removed.js", kind: "unknown" })],
    });
    expect(fakeScore(evidence)).toBe(0.15);
  });

  it("abstains when the test uses no module mocks", async () => {
    const projectFiles = await project("owned-mock-nomock", [
      "test/cart.test.ts",
      "src/cart.ts",
      "src/pricing.ts",
    ]);
    const owner = projectFiles[0];
    expect(owner).toBeDefined();
    if (!owner) return;
    const candidate = testCandidate(owner, "total(100, 10)");
    expect(candidate).toBeDefined();
    if (!candidate) return;

    const evidence = buildOwnedModuleMockEvidence(candidate, projectFiles);
    expect(evidence).toBeUndefined();
    expect(fakeScore(evidence)).toBeUndefined();
  });

  it("abstains for a candidate outside a test file", async () => {
    const projectFiles = await project("owned-mock-positive", [
      "test/cart.test.ts",
      "src/cart.ts",
      "src/pricing.ts",
    ]);
    const owner = projectFiles.find((file) => file.filePath === "src/cart.ts");
    expect(owner).toBeDefined();
    if (!owner) return;
    const candidate = extractCandidates(owner.filePath, owner.source)
      .filter(({ kind }) => kind === "function")
      .sort((left, right) => left.source.length - right.source.length)[0];
    expect(candidate).toBeDefined();
    if (!candidate) return;

    const evidence = buildOwnedModuleMockEvidence(candidate, projectFiles);
    expect(evidence).toBeUndefined();
    expect(fakeScore(evidence)).toBeUndefined();
  });
});
