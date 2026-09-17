import { readFile } from "node:fs/promises";
import { describe, expect, it } from "vitest";
import { extractCandidates } from "../src/candidates.js";
import { buildDivergentInversesEvidence } from "../src/evidence/divergent-inverses.js";
import type { ProjectFile } from "../src/types.js";

const repositories = new URL("./fixtures/repositories/", import.meta.url);

async function load(repository: string, filePath: string): Promise<ProjectFile> {
  return {
    filePath,
    source: await readFile(new URL(`${repository}/${filePath}`, repositories), "utf8"),
  };
}

describe("divergent inverses evidence", () => {
  it("shows Jev the writer-only fields the reader drops", async () => {
    const owner = await load("divergent-inverses-smelly", "src/codec.ts");
    const projectFiles = [owner];
    expect(owner).toBeDefined();
    if (!owner) return;
    const candidate = extractCandidates(owner.filePath, owner.source)
      .find((item) => item.kind === "function" && item.source.includes("serializeUser"));
    expect(candidate).toBeDefined();
    if (!candidate) return;

    const evidence = buildDivergentInversesEvidence(candidate, projectFiles);

    expect(evidence).toMatchObject({
      function: { name: "serializeUser" },
      inverse: { name: "parseUser" },
      writerOnly: ["createdAt", "lastLoginAt"],
      readerOnly: [],
    });
    expect(evidence?.symmetricDifference).toBe(2);
  });

  it("abstains when both sides cover the same fields", async () => {
    const owner = await load("divergent-inverses-symmetric", "src/codec.ts");
    const projectFiles = [owner];
    expect(owner).toBeDefined();
    if (!owner) return;
    const candidate = extractCandidates(owner.filePath, owner.source)
      .find((item) => item.kind === "function" && item.source.includes("serializeUser"));
    expect(candidate).toBeDefined();
    if (!candidate) return;

    expect(buildDivergentInversesEvidence(candidate, projectFiles)).toBeUndefined();
  });

  it("abstains when no inverse can be identified", () => {
    const source = "export function renderTotal(items: string[]) { return items.join(','); }";
    const candidate = extractCandidates("src/total.ts", source)
      .find((item) => item.kind === "function");
    expect(candidate).toBeDefined();
    if (!candidate) return;

    expect(buildDivergentInversesEvidence(candidate, [{ filePath: "src/total.ts", source }]))
      .toBeUndefined();
  });
});
