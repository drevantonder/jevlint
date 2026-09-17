import { readFile } from "node:fs/promises";
import { describe, expect, it } from "vitest";
import { extractCandidates } from "../src/candidates.js";
import { buildCoupledIndexCollectionsEvidence } from "../src/evidence/coupled-index-collections.js";
import type { Candidate, ProjectFile } from "../src/types.js";

const repositories = new URL("./fixtures/repositories/", import.meta.url);

async function project(name: string, paths: string[]): Promise<ProjectFile[]> {
  return Promise.all(paths.map(async (filePath) => ({
    filePath,
    source: await readFile(new URL(`${name}/${filePath}`, repositories), "utf8"),
  })));
}

function functionCandidate(owner: ProjectFile, marker: string): Candidate | undefined {
  return extractCandidates(owner.filePath, owner.source)
    .find((candidate) => candidate.kind === "function" && candidate.source.includes(marker));
}

describe("coupled index collections evidence", () => {
  it("extracts two lockstep collections under one shared index", async () => {
    const projectFiles = await project("coupled-index-collections-positive", [
      "src/report.ts",
    ]);
    const owner = projectFiles[0];
    expect(owner).toBeDefined();
    if (!owner) return;
    const candidate = functionCandidate(owner, "function buildReport");
    expect(candidate).toBeDefined();
    if (!candidate) return;

    const evidence = buildCoupledIndexCollectionsEvidence(candidate, projectFiles);

    expect(evidence).toMatchObject({
      function: { name: "buildReport", exported: true },
      collections: [
        { name: "names", provenance: "array-parameter" },
        { name: "scores", provenance: "array-parameter" },
      ],
      sharedIndex: "i",
      loop: expect.stringContaining("for"),
      pairedAccesses: expect.arrayContaining([
        expect.objectContaining({ collection: "names", access: "names[i]", kind: "read" }),
        expect.objectContaining({ collection: "scores", access: "scores[i]", kind: "read" }),
      ]),
    });
  });

  it("abstains when the collections advance with differing stride", async () => {
    const projectFiles = await project("coupled-index-collections-stride", [
      "src/compare.ts",
    ]);
    const owner = projectFiles[0];
    expect(owner).toBeDefined();
    if (!owner) return;
    const candidate = functionCandidate(owner, "function compare");
    expect(candidate).toBeDefined();
    if (!candidate) return;

    expect(buildCoupledIndexCollectionsEvidence(candidate, projectFiles)).toBeUndefined();
  });

  it("abstains when a pairing record already combines the elements", async () => {
    const projectFiles = await project("coupled-index-collections-paired", [
      "src/users.ts",
    ]);
    const owner = projectFiles[0];
    expect(owner).toBeDefined();
    if (!owner) return;
    const candidate = functionCandidate(owner, "function toUsers");
    expect(candidate).toBeDefined();
    if (!candidate) return;

    expect(buildCoupledIndexCollectionsEvidence(candidate, projectFiles)).toBeUndefined();
  });

  it("abstains when only one collection is indexed", async () => {
    const projectFiles = await project("coupled-index-collections-single", [
      "src/total.ts",
    ]);
    const owner = projectFiles[0];
    expect(owner).toBeDefined();
    if (!owner) return;
    const candidate = functionCandidate(owner, "function total");
    expect(candidate).toBeDefined();
    if (!candidate) return;

    expect(buildCoupledIndexCollectionsEvidence(candidate, projectFiles)).toBeUndefined();
  });

  it("abstains for non-function candidates", async () => {
    const projectFiles = await project("coupled-index-collections-positive", [
      "src/report.ts",
    ]);
    const owner = projectFiles[0];
    expect(owner).toBeDefined();
    if (!owner) return;

    expect(buildCoupledIndexCollectionsEvidence(
      {
        id: "abstraction-fixture",
        kind: "abstraction",
        filePath: owner.filePath,
        source: "type Report = string[];",
        start: 0,
        end: 24,
        startLine: 1,
        startColumn: 0,
        endLine: 1,
        endColumn: 24,
      },
      projectFiles,
    )).toBeUndefined();
  });
});
