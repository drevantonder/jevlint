import { readFile } from "node:fs/promises";
import { describe, expect, it } from "vitest";
import { extractCandidates } from "../src/candidates.js";
import { buildDuplicatedFixtureDriftEvidence } from "../src/evidence/duplicated-fixture-drift.js";
import type { ProjectFile } from "../src/types.js";

const repositories = new URL("./fixtures/repositories/", import.meta.url);

async function project(name: string, paths: string[]): Promise<ProjectFile[]> {
  return Promise.all(paths.map(async (filePath) => ({
    filePath,
    source: await readFile(new URL(`${name}/${filePath}`, repositories), "utf8"),
  })));
}

describe("duplicated fixture drift evidence", () => {
  it("flags setup copies that disagree on fixture fields", async () => {
    const projectFiles = await project("fixture-drift-positive", [
      "test/orders.test.ts",
      "test/refunds.test.ts",
    ]);
    const owner = projectFiles[0];
    expect(owner).toBeDefined();
    if (!owner) return;
    const candidate = extractCandidates(owner.filePath, owner.source)
      .filter(({ kind, source }) => kind === "function" && source.includes("order = {"))
      .sort((left, right) => left.source.length - right.source.length)[0];
    expect(candidate).toBeDefined();
    if (!candidate) return;

    expect(buildDuplicatedFixtureDriftEvidence(candidate, projectFiles)).toMatchObject({
      copies: [{ filePath: "test/refunds.test.ts" }],
      divergence: [expect.objectContaining({ field: "vip" })],
      sharedFactoryExists: false,
    });
  });

  it("abstains when the setup has no copy elsewhere", async () => {
    const projectFiles = await project("fixture-single", ["test/orders.test.ts"]);
    const owner = projectFiles[0];
    expect(owner).toBeDefined();
    if (!owner) return;
    const candidate = extractCandidates(owner.filePath, owner.source)
      .filter(({ kind, source }) => kind === "function" && source.includes("order = {"))
      .sort((left, right) => left.source.length - right.source.length)[0];
    expect(candidate).toBeDefined();
    if (!candidate) return;

    expect(buildDuplicatedFixtureDriftEvidence(candidate, projectFiles)).toBeUndefined();
  });

  it("abstains when the test builds fixtures through a shared factory", async () => {
    const projectFiles = await project("fixture-shared", [
      "test/orders.test.ts",
      "src/order-factory.ts",
    ]);
    const owner = projectFiles[0];
    expect(owner).toBeDefined();
    if (!owner) return;
    const candidate = extractCandidates(owner.filePath, owner.source)
      .filter(({ kind, source }) => kind === "function" && source.includes("createOrder(40)"))
      .sort((left, right) => left.source.length - right.source.length)[0];
    expect(candidate).toBeDefined();
    if (!candidate) return;

    expect(buildDuplicatedFixtureDriftEvidence(candidate, projectFiles)).toBeUndefined();
  });
});
