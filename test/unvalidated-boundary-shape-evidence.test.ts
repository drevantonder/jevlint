import { readFile } from "node:fs/promises";
import { describe, expect, it } from "vitest";
import { extractCandidates } from "../src/candidates.js";
import { buildUnvalidatedBoundaryEvidence } from "../src/evidence/unvalidated-boundary-shape.js";
import type { ProjectFile } from "../src/types.js";

async function project(name: string, paths: string[]): Promise<ProjectFile[]> {
  return Promise.all(paths.map(async (filePath) => ({
    filePath,
    source: await readFile(
      new URL(`./fixtures/repositories/${name}/${filePath}`, import.meta.url),
      "utf8",
    ),
  })));
}

function candidateFor(files: ProjectFile[], filePath: string, marker: string) {
  const file = files.find((entry) => entry.filePath === filePath);
  expect(file).toBeDefined();
  if (!file) return undefined;
  const candidate = extractCandidates(file.filePath, file.source)
    .find(({ source }) => source.includes(marker));
  expect(candidate).toBeDefined();
  return candidate;
}

describe("unvalidated boundary shape evidence", () => {
  it("shows Jev the wrapper reads, missing validators, and actual callers", async () => {
    const files = await project("unvalidated-boundary-shape-positive", [
      "src/handler.ts",
      "src/schemas.ts",
      "src/store.ts",
      "src/caller.ts",
    ]);
    const candidate = candidateFor(files, "src/handler.ts", "persistCredential");
    if (!candidate) return;

    const evidence = buildUnvalidatedBoundaryEvidence(candidate, files);

    expect(evidence).toMatchObject({
      function: {
        name: "persistCredential",
        exported: true,
        source: expect.stringContaining("store.save(result)"),
      },
      boundaryReads: expect.arrayContaining([
        expect.objectContaining({ origin: "parse-wrapper", property: "data" }),
      ]),
      validators: [],
      callers: [{ filePath: "src/caller.ts", call: expect.stringContaining("persistCredential") }],
    });
  });

  it("records the success guard when validation precedes the use", async () => {
    const files = await project("unvalidated-boundary-shape-guarded", [
      "src/handler.ts",
      "src/schemas.ts",
      "src/store.ts",
    ]);
    const candidate = candidateFor(files, "src/handler.ts", "persistCredential");
    if (!candidate) return;

    const evidence = buildUnvalidatedBoundaryEvidence(candidate, files);

    expect(evidence).toMatchObject({
      function: { name: "persistCredential" },
      validators: [{ kind: "success-check", expression: expect.stringContaining("success") }],
    });
  });

  it("abstains when the function never touches a boundary value", async () => {
    const files = await project("unvalidated-boundary-shape-negative", ["src/handler.ts"]);
    const candidate = candidateFor(files, "src/handler.ts", "formatToken");
    if (!candidate) return;

    expect(buildUnvalidatedBoundaryEvidence(candidate, files)).toBeUndefined();
  });
});
