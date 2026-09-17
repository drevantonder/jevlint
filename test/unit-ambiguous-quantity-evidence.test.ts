import { readFile } from "node:fs/promises";
import { describe, expect, it } from "vitest";
import { extractCandidates } from "../src/candidates.js";
import { buildUnitAmbiguousQuantityEvidence } from "../src/evidence/unit-ambiguous-quantity.js";
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

describe("unit ambiguous quantity evidence", () => {
  it("flags a bare-number timeout with raw literal callers", async () => {
    const projectFiles = await project("unit-ambiguous-positive", [
      "src/retry.ts",
      "src/handler.ts",
    ]);
    const owner = projectFiles[0];
    expect(owner).toBeDefined();
    if (!owner) return;
    const candidate = namedFunction(owner, "scheduleRetry");
    expect(candidate).toBeDefined();
    if (!candidate) return;

    const evidence = buildUnitAmbiguousQuantityEvidence(candidate, projectFiles);

    expect(evidence).toMatchObject({
      function: { name: "scheduleRetry", exported: true, filePath: "src/retry.ts" },
      quantities: [
        {
          name: "timeout",
          annotation: "number",
          literalCallers: [expect.stringContaining("scheduleRetry(5000)")],
        },
      ],
    });
  });

  it("abstains when the name carries a unit suffix", async () => {
    const projectFiles = await project("unit-ambiguous-negative", ["src/retry.ts"]);
    const owner = projectFiles[0];
    expect(owner).toBeDefined();
    if (!owner) return;
    const candidate = namedFunction(owner, "scheduleRetry");
    expect(candidate).toBeDefined();
    if (!candidate) return;

    expect(buildUnitAmbiguousQuantityEvidence(candidate, projectFiles)).toBeUndefined();
  });

  it("abstains when the body converts scales", () => {
    const source = `export function backoff(timeout: number) {\n  return timeout * 1000;\n}`;
    const candidate = extractCandidates("src/backoff.ts", source)
      .find(({ kind }) => kind === "function");
    expect(candidate).toBeDefined();
    if (!candidate) return;

    expect(
      buildUnitAmbiguousQuantityEvidence(candidate, [{ filePath: "src/backoff.ts", source }]),
    ).toBeUndefined();
  });
});
