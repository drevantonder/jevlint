import { readFile } from "node:fs/promises";
import { describe, expect, it } from "vitest";
import { defaultConfig } from "../src/config.js";
import { extractCandidates } from "../src/candidates.js";
import { buildRuleEvidence } from "../src/evidence/index.js";
import { buildHandRolledCsvSplitEvidence } from "../src/evidence/hand-rolled-csv-split.js";
import type { Candidate, ProjectFile } from "../src/types.js";

const RULE = "jev/no-hand-rolled-csv-split";
const repositories = new URL("./fixtures/repositories/", import.meta.url);

async function project(name: string, paths: string[]): Promise<ProjectFile[]> {
  return Promise.all(paths.map(async (filePath) => ({
    filePath,
    source: await readFile(new URL(`${name}/${filePath}`, repositories), "utf8"),
  })));
}

function functionCandidate(files: ProjectFile[], filePart: string, name: string): Candidate {
  const owner = files.find((file) => file.filePath.includes(filePart));
  expect(owner).toBeDefined();
  if (!owner) throw new Error("Fixture has no candidate file.");
  const candidate = extractCandidates(owner.filePath, owner.source)
    .find((entry) => entry.kind === "function" && entry.source.includes(name));
  expect(candidate).toBeDefined();
  if (!candidate) throw new Error(`Fixture has no function containing ${name}.`);
  return candidate;
}

describe("hand rolled csv split wiring", () => {
  it("ships as a function judgment without thresholds", () => {
    expect(defaultConfig.rules[RULE]).toMatchObject({
      scope: "function",
      message: expect.any(String),
    });
    expect(defaultConfig.rules[RULE]).not.toHaveProperty("threshold");
    expect(defaultConfig.rules[RULE]).not.toHaveProperty("severity");
  });

  it("flags naive splitting beside an installed CSV dep", async () => {
    const files = await project("hand-rolled-csv-split-positive", [
      "package.json",
      "src/csv.ts",
      "src/importer.ts",
    ]);

    const result = buildRuleEvidence(
      RULE,
      functionCandidate(files, "csv", "parseCsv"),
      files,
    );

    expect(result).toEqual({ handled: true, evidence: expect.any(Object) });
    if (!result.handled) return;
    expect(result.evidence).toMatchObject({
      ownedCsvDep: "papaparse",
      siblingImporters: ["src/importer.ts"],
      handlesQuotes: false,
      signals: expect.arrayContaining([
        expect.objectContaining({ signal: "row-split" }),
        expect.objectContaining({ signal: "cell-split" }),
      ]),
    });
  });

  it("abstains without an installed CSV dep", () => {
    const source = `export function parseCsv(input: string): string[][] {
  return input.split("\\n").map((line) => line.split(","));
}
`;
    const candidate = extractCandidates("src/csv.ts", source)
      .find((entry) => entry.kind === "function");
    expect(candidate).toBeDefined();
    if (!candidate) return;
    expect(buildHandRolledCsvSplitEvidence(candidate, [
      { filePath: "package.json", source: JSON.stringify({ dependencies: {} }) },
      { filePath: "src/csv.ts", source },
    ])).toBeUndefined();
  });

  it("abstains for row splitting without cell splitting", () => {
    const source = `export function lines(input: string): string[] {
  return input.split("\\n").map((line) => line.trim());
}
`;
    const candidate = extractCandidates("src/csv.ts", source)
      .find((entry) => entry.kind === "function");
    expect(candidate).toBeDefined();
    if (!candidate) return;
    expect(buildHandRolledCsvSplitEvidence(candidate, [
      { filePath: "package.json", source: JSON.stringify({ dependencies: { papaparse: "^5.0.0" } }) },
      { filePath: "src/csv.ts", source },
    ])).toBeUndefined();
  });
});
