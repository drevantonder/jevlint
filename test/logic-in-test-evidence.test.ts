import { readFile } from "node:fs/promises";
import { describe, expect, it } from "vitest";
import { extractCandidates } from "../src/candidates.js";
import { buildLogicInTestEvidence } from "../src/evidence/logic-in-test.js";
import type { ProjectFile } from "../src/types.js";

const repositories = new URL("./fixtures/repositories/", import.meta.url);

async function project(name: string, paths: string[]): Promise<ProjectFile[]> {
  return Promise.all(paths.map(async (filePath) => ({
    filePath,
    source: await readFile(new URL(`${name}/${filePath}`, repositories), "utf8"),
  })));
}

describe("logic in test evidence", () => {
  it("flags a test branching on the subject predicate", async () => {
    const projectFiles = await project("logic-positive", [
      "test/pricing.test.ts",
      "src/pricing.ts",
    ]);
    const owner = projectFiles[0];
    expect(owner).toBeDefined();
    if (!owner) return;
    const candidate = extractCandidates(owner.filePath, owner.source)
      .filter(({ kind, source }) => kind === "function" && source.includes("if (vip)"))
      .sort((left, right) => left.source.length - right.source.length)[0];
    expect(candidate).toBeDefined();
    if (!candidate) return;

    expect(buildLogicInTestEvidence(candidate, projectFiles)).toMatchObject({
      logic: [expect.objectContaining({ kind: "if", condition: "vip" })],
      dataTable: false,
      mirrorsSubjectPredicate: true,
    });
  });

  it("abstains for a linear test", async () => {
    const projectFiles = await project("logic-negative", [
      "test/pricing.test.ts",
      "src/pricing.ts",
    ]);
    const owner = projectFiles[0];
    expect(owner).toBeDefined();
    if (!owner) return;
    const candidate = extractCandidates(owner.filePath, owner.source)
      .filter(({ kind, source }) => kind === "function" && source.includes("discountRate(true)"))
      .sort((left, right) => left.source.length - right.source.length)[0];
    expect(candidate).toBeDefined();
    if (!candidate) return;

    expect(buildLogicInTestEvidence(candidate, projectFiles)).toBeUndefined();
  });

  it("marks a data-driven table as enumerated cases", async () => {
    const projectFiles = await project("logic-table", [
      "test/pricing.test.ts",
      "src/pricing.ts",
    ]);
    const owner = projectFiles[0];
    expect(owner).toBeDefined();
    if (!owner) return;
    const candidate = extractCandidates(owner.filePath, owner.source)
      .filter(({ kind, source }) => kind === "function" && source.includes("discountRate(vip)"))
      .sort((left, right) => left.source.length - right.source.length)[0];
    expect(candidate).toBeDefined();
    if (!candidate) return;

    expect(buildLogicInTestEvidence(candidate, projectFiles)).toMatchObject({
      dataTable: true,
    });
  });
});
