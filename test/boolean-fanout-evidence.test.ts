import { readFile } from "node:fs/promises";
import { describe, expect, it } from "vitest";
import { extractCandidates } from "../src/candidates.js";
import { buildBooleanFanoutEvidence } from "../src/evidence/boolean-fanout.js";
import type { ProjectFile } from "../src/types.js";

const root = new URL("./fixtures/repositories/boolean-fanout-positive/", import.meta.url);
const negativeRoot = new URL("./fixtures/repositories/boolean-fanout-negative/", import.meta.url);

async function load(base: URL, filePath: string): Promise<ProjectFile> {
  return { filePath, source: await readFile(new URL(filePath, base), "utf8") };
}

describe("boolean fanout evidence", () => {
  it("clusters same-stem booleans with their multi-set call sites", async () => {
    const projectFiles = await Promise.all([
      "src/export-format.ts",
      "src/render.ts",
    ].map((filePath) => load(root, filePath)));
    const owner = projectFiles[0];
    expect(owner).toBeDefined();
    if (!owner) return;
    const candidate = extractCandidates(owner.filePath, owner.source)
      .find(({ kind }) => kind === "abstraction");
    expect(candidate).toBeDefined();
    if (!candidate) return;

    const evidence = buildBooleanFanoutEvidence(candidate, projectFiles);

    expect(evidence).toMatchObject({
      stateType: {
        name: "ExportFormat",
        filePath: "src/export-format.ts",
      },
      booleanProperties: [
        { name: "formatJson" },
        { name: "formatYaml" },
        { name: "formatTable" },
      ],
      clusters: [{ stem: "format", members: ["formatJson", "formatTable", "formatYaml"] }],
      usages: expect.arrayContaining([
        expect.objectContaining({ filePath: "src/render.ts", kind: "function" }),
      ]),
      multiSetSites: expect.arrayContaining([
        expect.objectContaining({ filePath: "src/render.ts" }),
      ]),
    });
  });

  it("abstains when no same-stem cluster reaches width three", async () => {
    const projectFiles = await Promise.all(["src/view-toggles.ts"].map((filePath) => load(negativeRoot, filePath)));
    const owner = projectFiles[0];
    expect(owner).toBeDefined();
    if (!owner) return;
    const candidate = extractCandidates(owner.filePath, owner.source)
      .find(({ kind }) => kind === "abstraction");
    expect(candidate).toBeDefined();
    if (!candidate) return;

    expect(buildBooleanFanoutEvidence(candidate, projectFiles)).toBeUndefined();
  });

  it("abstains when a nearby tagged union already names the discriminant", () => {
    const source = `export type Format = "json" | "yaml" | "table";
export interface ExportFormat { formatJson: boolean; formatYaml: boolean; formatTable: boolean }`;
    const target = extractCandidates("src/export-format.ts", source)
      .filter(({ kind }) => kind === "abstraction")
      .find((item) => item.source.includes("formatJson"));
    expect(target).toBeDefined();
    if (!target) return;

    expect(buildBooleanFanoutEvidence(target, [
      { filePath: "src/export-format.ts", source },
    ])).toBeUndefined();
  });
});
