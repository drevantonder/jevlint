import { readFile } from "node:fs/promises";
import { describe, expect, it } from "vitest";
import { extractCandidates } from "../src/candidates.js";
import { buildAmbientDependencyGrabEvidence } from "../src/evidence/ambient-dependency-grab.js";
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

describe("ambient dependency grab evidence", () => {
  it("flags a static singleton accessor with the dependency missing from parameters", async () => {
    const projectFiles = await project("ambient-grab-positive", [
      "src/db.ts",
      "src/orders.ts",
      "src/route.ts",
    ]);
    const owner = projectFiles[1];
    expect(owner).toBeDefined();
    if (!owner) return;
    const candidate = namedFunction(owner, "placeOrder");
    expect(candidate).toBeDefined();
    if (!candidate) return;

    const evidence = buildAmbientDependencyGrabEvidence(candidate, projectFiles);

    expect(evidence).toMatchObject({
      function: {
        name: "placeOrder",
        exported: true,
        filePath: "src/orders.ts",
      },
      accesses: [
        { kind: "singleton", root: "Db", expression: expect.stringContaining("getInstance") },
      ],
      callers: [expect.objectContaining({ filePath: "src/route.ts" })],
    });
    expect(evidence?.function.parameters).toEqual(["id: string"]);
  });

  it("abstains when the dependency arrives through parameters", async () => {
    const projectFiles = await project("ambient-grab-negative", [
      "src/db.ts",
      "src/orders.ts",
      "src/route.ts",
    ]);
    const owner = projectFiles[1];
    expect(owner).toBeDefined();
    if (!owner) return;
    const candidate = namedFunction(owner, "placeOrder");
    expect(candidate).toBeDefined();
    if (!candidate) return;

    expect(buildAmbientDependencyGrabEvidence(candidate, projectFiles)).toBeUndefined();
  });

  it("abstains on fixed runtime inputs owned by hidden-runtime-input", async () => {
    const projectFiles = await project("hidden-runtime-input-positive", [
      "src/checkout.ts",
      "src/quote-shipping.ts",
    ]);
    for (const file of projectFiles) {
      for (
        const candidate of extractCandidates(file.filePath, file.source)
          .filter(({ kind }) => kind === "function")
      ) {
        expect(buildAmbientDependencyGrabEvidence(candidate, projectFiles)).toBeUndefined();
      }
    }
  });

  it("abstains for non-function candidates", async () => {    const projectFiles = await project("ambient-grab-positive", ["src/orders.ts"]);
    const owner = projectFiles[0];
    expect(owner).toBeDefined();
    if (!owner) return;
    const abstraction = extractCandidates(owner.filePath, owner.source)
      .find(({ kind }) => kind === "abstraction");
    if (!abstraction) return;
    expect(buildAmbientDependencyGrabEvidence(abstraction, projectFiles)).toBeUndefined();
  });
});
