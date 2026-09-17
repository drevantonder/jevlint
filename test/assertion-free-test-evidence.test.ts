import { readFile } from "node:fs/promises";
import { describe, expect, it } from "vitest";
import { extractCandidates } from "../src/candidates.js";
import { buildAssertionFreeTestEvidence } from "../src/evidence/assertion-free-test.js";
import type { ProjectFile } from "../src/types.js";

const repositories = new URL("./fixtures/repositories/", import.meta.url);

async function project(name: string, paths: string[]): Promise<ProjectFile[]> {
  return Promise.all(paths.map(async (filePath) => ({
    filePath,
    source: await readFile(new URL(`${name}/${filePath}`, repositories), "utf8"),
  })));
}

describe("assertion free test evidence", () => {
  it("flags a test that exercises the subject with no assertion", async () => {
    const projectFiles = await project("assertion-free-positive", [
      "test/order.test.ts",
      "src/order.ts",
    ]);
    const owner = projectFiles[0];
    expect(owner).toBeDefined();
    if (!owner) return;
    const candidate = extractCandidates(owner.filePath, owner.source)
      .filter(({ kind, source }) => kind === "function" && source.includes('process({ id: "o2"'))
      .sort((left, right) => left.source.length - right.source.length)[0];
    expect(candidate).toBeDefined();
    if (!candidate) return;

    expect(buildAssertionFreeTestEvidence(candidate, projectFiles)).toMatchObject({
      function: { title: "processes an order without surprises" },
      assertionCalls: [],
      subjectCalls: [expect.stringContaining("process(")],
      smokeContract: false,
    });
  });

  it("abstains when the test asserts on the subject", async () => {
    const projectFiles = await project("assertion-free-negative", [
      "test/order.test.ts",
      "src/order.ts",
    ]);
    const owner = projectFiles[0];
    expect(owner).toBeDefined();
    if (!owner) return;
    const candidate = extractCandidates(owner.filePath, owner.source)
      .filter(({ kind, source }) => kind === "function" && source.includes("computes the total"))
      .sort((left, right) => left.source.length - right.source.length)[0];
    expect(candidate).toBeDefined();
    if (!candidate) return;

    expect(buildAssertionFreeTestEvidence(candidate, projectFiles)).toBeUndefined();
  });

  it("abstains for production files", async () => {
    const projectFiles = await project("assertion-free-negative", [
      "test/order.test.ts",
      "src/order.ts",
    ]);
    const owner = projectFiles[1];
    expect(owner).toBeDefined();
    if (!owner) return;
    const candidate = extractCandidates(owner.filePath, owner.source)
      .find(({ kind }) => kind === "function");
    expect(candidate).toBeDefined();
    if (!candidate) return;

    expect(buildAssertionFreeTestEvidence(candidate, projectFiles)).toBeUndefined();
  });
});
