import { readFile } from "node:fs/promises";
import { describe, expect, it } from "vitest";
import { extractCandidates } from "../src/candidates.js";
import { buildTemporaryFieldEvidence } from "../src/evidence/temporary-field.js";
import type { ProjectFile } from "../src/types.js";

const root = new URL("./fixtures/repositories/temporary-field-smelly/", import.meta.url);

async function load(filePath: string): Promise<ProjectFile> {
  return { filePath, source: await readFile(new URL(filePath, root), "utf8") };
}

describe("temporary field evidence", () => {
  it("shows a field written and read in different methods", async () => {
    const projectFiles = await Promise.all([
      "src/document.ts",
      "src/preview.ts",
      "src/strict.ts",
    ].map(load));
    const owner = projectFiles[0];
    expect(owner).toBeDefined();
    if (!owner) return;
    const candidate = extractCandidates(owner.filePath, owner.source)
      .find(({ kind }) => kind === "abstraction");
    expect(candidate).toBeDefined();
    if (!candidate) return;

    const evidence = buildTemporaryFieldEvidence(candidate, projectFiles);

    expect(evidence).toMatchObject({
      abstraction: {
        name: "Document",
        kind: "class",
        source: expect.stringContaining("class Document"),
      },
      fields: expect.arrayContaining([
        expect.objectContaining({
          name: "parsed",
          optional: true,
          assignedInConstructor: false,
          assignedInMethods: ["parse"],
          readInMethods: ["render"],
        }),
      ]),
      sequence: expect.arrayContaining([
        expect.objectContaining({ method: "render", externalCalls: 1 }),
        expect.objectContaining({ method: "parse", externalCalls: 0 }),
      ]),
    });
    expect(evidence?.fields.find(({ name }) => name === "parsed")?.guardedReads)
      .toBeGreaterThan(0);
    expect(evidence?.fields.find(({ name }) => name === "title")?.assignedInConstructor)
      .toBe(true);
  });

  it("abstains when every field is assigned at construction", async () => {
    const source = await readFile(new URL("src/strict.ts", root), "utf8");
    const candidate = extractCandidates("src/strict.ts", source)
      .find(({ kind }) => kind === "abstraction");
    expect(candidate).toBeDefined();
    if (!candidate) return;

    expect(buildTemporaryFieldEvidence(candidate, [{ filePath: "src/strict.ts", source }]))
      .toBeUndefined();
  });
});
