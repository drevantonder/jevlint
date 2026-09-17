import { readFile } from "node:fs/promises";
import { describe, expect, it } from "vitest";
import { extractCandidates } from "../src/candidates.js";
import { buildSinglyOwnedLazySharedStateEvidence } from "../src/evidence/singly-owned-lazy-shared-state.js";
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

describe("singly owned lazy shared state evidence", () => {
  it("flags guard-then-assign behind an initialized binding with readers beyond the writer", async () => {
    const projectFiles = await project("lazy-shared-positive", [
      "src/settings.ts",
      "src/cache.ts",
      "src/page.ts",
    ]);
    const owner = projectFiles[1];
    expect(owner).toBeDefined();
    if (!owner) return;
    const candidate = namedFunction(owner, "getSettings");
    expect(candidate).toBeDefined();
    if (!candidate) return;

    const evidence = buildSinglyOwnedLazySharedStateEvidence(candidate, projectFiles);

    expect(evidence).toMatchObject({
      function: { name: "getSettings", exported: true, filePath: "src/cache.ts" },
      sharedStates: [
        {
          binding: "cached",
          declaration: expect.stringContaining("let cached"),
          guard: expect.stringContaining("!cached"),
          assignment: expect.stringContaining("cached = loadSettings()"),
          readers: ["hasCache"],
          resetOrInspectExport: null,
        },
      ],
    });
  });

  it("abstains on load-time initialization with no lazy guard", async () => {
    const projectFiles = await project("lazy-shared-negative", [
      "src/settings.ts",
      "src/cache.ts",
    ]);
    const owner = projectFiles[1];
    expect(owner).toBeDefined();
    if (!owner) return;
    const candidate = namedFunction(owner, "getSettings");
    expect(candidate).toBeDefined();
    if (!candidate) return;

    expect(buildSinglyOwnedLazySharedStateEvidence(candidate, projectFiles)).toBeUndefined();
  });

  it("abstains on multi-writer shared state owned elsewhere", async () => {
    const projectFiles = await project("shared-mutable-positive", [
      "src/batch.ts",
      "src/consumer.ts",
    ]);
    const owner = projectFiles[0];
    expect(owner).toBeDefined();
    if (!owner) return;
    const candidate = extractCandidates(owner.filePath, owner.source)
      .find(({ kind }) => kind === "function");
    expect(candidate).toBeDefined();
    if (!candidate) return;

    expect(buildSinglyOwnedLazySharedStateEvidence(candidate, projectFiles)).toBeUndefined();
  });

  it("abstains on uninitialized bindings owned by initialization order", async () => {
    const projectFiles = await project("hidden-initialization-order-positive", [
      "src/bootstrap.ts",
      "src/checkout.ts",
      "src/payments.ts",
    ]);
    for (const file of projectFiles) {
      for (
        const candidate of extractCandidates(file.filePath, file.source)
          .filter(({ kind }) => kind === "function")
      ) {
        expect(buildSinglyOwnedLazySharedStateEvidence(candidate, projectFiles)).toBeUndefined();
      }
    }
  });
});
