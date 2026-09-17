import { readFile } from "node:fs/promises";
import { describe, expect, it } from "vitest";
import { extractCandidates } from "../src/candidates.js";
import { buildHeterogeneousPrimitiveCallersEvidence } from "../src/evidence/heterogeneous-primitive-callers.js";
import type { ProjectFile } from "../src/types.js";

const repositories = new URL("./fixtures/repositories/", import.meta.url);

async function project(name: string, paths: string[]): Promise<ProjectFile[]> {
  return Promise.all(paths.map(async (filePath) => ({
    filePath,
    source: await readFile(new URL(`${name}/${filePath}`, repositories), "utf8"),
  })));
}

function namedFunction(file: ProjectFile, name: string) {
  return extractCandidates(file.filePath, file.source)
    .find(({ kind, source }) => kind === "function" && source.includes(`function ${name}`));
}

describe("heterogeneous primitive callers evidence", () => {
  it("flags one string slot fed by user- and org-stemmed callers", async () => {
    const projectFiles = await project("heterogeneous-callers-positive", [
      "src/lookup.ts",
      "src/users.ts",
      "src/orgs.ts",
    ]);
    const owner = projectFiles[0];
    expect(owner).toBeDefined();
    if (!owner) return;
    const candidate = namedFunction(owner, "lookupAccount");
    expect(candidate).toBeDefined();
    if (!candidate) return;

    const evidence = buildHeterogeneousPrimitiveCallersEvidence(candidate, projectFiles);

    expect(evidence).toMatchObject({
      function: { name: "lookupAccount", exported: true, filePath: "src/lookup.ts" },
      parameter: { index: 0, name: "id", source: "id: string" },
      stems: expect.arrayContaining([
        { stem: "user", calls: [expect.stringContaining("user.id")] },
        { stem: "org", calls: [expect.stringContaining("org.id")] },
      ]),
    });
    expect(evidence?.callers.length).toBeGreaterThanOrEqual(2);
  });

  it("abstains when every caller stem agrees", async () => {
    const projectFiles = await project("heterogeneous-callers-negative", [
      "src/lookup.ts",
      "src/users.ts",
      "src/admins.ts",
    ]);
    const owner = projectFiles[0];
    expect(owner).toBeDefined();
    if (!owner) return;
    const candidate = namedFunction(owner, "lookupAccount");
    expect(candidate).toBeDefined();
    if (!candidate) return;

    expect(buildHeterogeneousPrimitiveCallersEvidence(candidate, projectFiles)).toBeUndefined();
  });

  it("abstains on the interchangeable two-parameter shape", async () => {
    const projectFiles = await project("domain-primitives-positive", [
      "src/domain/transfer-funds.ts",
      "src/application/execute-transfer.ts",
    ]);
    const owner = projectFiles[0];
    expect(owner).toBeDefined();
    if (!owner) return;
    const candidate = namedFunction(owner, "transferFunds");
    expect(candidate).toBeDefined();
    if (!candidate) return;

    expect(buildHeterogeneousPrimitiveCallersEvidence(candidate, projectFiles)).toBeUndefined();
  });
});
