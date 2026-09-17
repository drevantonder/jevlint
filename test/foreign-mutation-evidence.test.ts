import { describe, expect, it } from "vitest";
import { extractCandidates } from "../src/candidates.js";
import { buildForeignMutationEvidence } from "../src/evidence/foreign-mutation.js";
import type { ProjectFile } from "../src/types.js";

function files(ownerSource: string, extra: ProjectFile[] = []): ProjectFile[] {
  return [{ filePath: "src/policy.ts", source: ownerSource }, ...extra];
}

function changedFunction(ownerSource: string) {
  const projectFiles = files(ownerSource, [
    { filePath: "src/store.ts", source: "export const cache: Record<string, string> = {};\n" },
  ]);
  const candidate = extractCandidates("src/policy.ts", ownerSource)
    .find(({ kind }) => kind === "function");
  expect(candidate).toBeDefined();
  if (!candidate) throw new Error("Fixture has no function candidate.");
  return { candidate, projectFiles };
}

describe("foreign mutation evidence", () => {
  it("reports writes to an imported binding and the import source", () => {
    const { candidate, projectFiles } = changedFunction(
      "import { cache } from \"./store.js\";\n"
      + "export function warmCache(entries: Record<string, string>): void {\n"
      + "  cache.entries = entries;\n"
      + "}\n",
    );

    const evidence = buildForeignMutationEvidence(candidate, projectFiles);

    expect(evidence).toMatchObject({
      function: { name: "warmCache", exported: true },
      mutations: [
        { target: "cache.entries", ownership: "imported-binding" },
      ],
      importedTargets: [{ local: "cache", source: "./store.js" }],
    });
  });

  it("reports prototype augmentation as foreign", () => {
    const { candidate, projectFiles } = changedFunction(
      "export function polyfillGroupBy(): void {\n"
      + "  (Array.prototype as Record<string, unknown>).groupBy = () => [];\n"
      + "}\n",
    );

    expect(buildForeignMutationEvidence(candidate, projectFiles)).toMatchObject({
      mutations: [expect.objectContaining({ ownership: "prototype" })],
    });
  });

  it("abstains when the function mutates only its own parameter", () => {
    const { candidate, projectFiles } = changedFunction(
      "export function normalize(input: { tags: string[] }): void {\n"
      + "  input.tags.sort();\n"
      + "}\n",
    );

    expect(buildForeignMutationEvidence(candidate, projectFiles)).toBeUndefined();
  });

  it("abstains when the function touches only locals", () => {
    const { candidate, projectFiles } = changedFunction(
      "export function total(values: number[]): number {\n"
      + "  let sum = 0;\n"
      + "  for (const value of values) sum += value;\n"
      + "  return sum;\n"
      + "}\n",
    );

    expect(buildForeignMutationEvidence(candidate, projectFiles)).toBeUndefined();
  });
});
