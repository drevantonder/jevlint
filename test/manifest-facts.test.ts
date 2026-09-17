import { describe, expect, it } from "vitest";
import { manifestFacts } from "../src/evidence/manifest-facts.js";
import type { ProjectFile } from "../src/types.js";

function files(entries: Array<[string, string]>): ProjectFile[] {
  return entries.map(([filePath, source]) => ({ filePath, source }));
}

describe("manifest facts", () => {
  it("reports the matched dep, sibling importers, and lockfile presence", () => {
    const facts = manifestFacts(
      files([
        ["package.json", JSON.stringify({ dependencies: { zod: "^3.0.0" } })],
        ["pnpm-lock.yaml", "lockfileVersion: 9\n"],
        ["src/validate.ts", "export function validateUser(): void {}"],
        ["src/service.ts", 'import { z } from "zod";\nexport const s = z.string();'],
      ]),
      "src/validate.ts",
      ["zod", "ajv"],
    );

    expect(facts).toMatchObject({
      hasManifest: true,
      matchedDep: "zod",
      siblingImporters: ["src/service.ts"],
      candidateImportsDep: false,
      lockfilePresent: true,
    });
    expect(facts.dependencyNames).toContain("zod");
  });

  it("flags when the candidate already imports the owned dep", () => {
    const facts = manifestFacts(
      files([
        ["package.json", JSON.stringify({ dependencies: { "p-retry": "^5.0.0" } })],
        ["src/fetch.ts", 'import pRetry from "p-retry";\nexport const run = (): unknown => pRetry;'],
      ]),
      "src/fetch.ts",
      ["p-retry"],
    );

    expect(facts.matchedDep).toBe("p-retry");
    expect(facts.candidateImportsDep).toBe(true);
    expect(facts.siblingImporters).toEqual([]);
  });

  it("returns no match when the manifest lacks every candidate dep", () => {
    const facts = manifestFacts(
      files([["package.json", JSON.stringify({ dependencies: {} })]]),
      "src/pool.ts",
      ["p-limit"],
    );

    expect(facts.hasManifest).toBe(true);
    expect(facts.matchedDep).toBeNull();
  });

  it("handles a missing or unparseable manifest", () => {
    expect(
      manifestFacts(files([["src/a.ts", "export const a = 1;"]]), "src/a.ts", ["zod"]).hasManifest,
    ).toBe(false);
    expect(
      manifestFacts(files([["package.json", "not json"]]), "src/a.ts", ["zod"]).hasManifest,
    ).toBe(false);
  });
});
