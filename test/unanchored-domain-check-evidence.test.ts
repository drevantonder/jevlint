import { readFile } from "node:fs/promises";
import { describe, expect, it } from "vitest";
import { extractCandidates } from "../src/candidates.js";
import { buildUnanchoredDomainCheckEvidence } from "../src/evidence/unanchored-domain-check.js";
import type { ProjectFile } from "../src/types.js";

const repositories = new URL("./fixtures/repositories/", import.meta.url);

async function project(name: string, paths: string[]): Promise<ProjectFile[]> {
  return Promise.all(paths.map(async (filePath) => ({
    filePath,
    source: await readFile(new URL(`${name}/${filePath}`, repositories), "utf8"),
  })));
}

describe("unanchored domain check evidence", () => {
  it("extracts substring host checks, parse signals, and callers", async () => {
    const projectFiles = await project("unanchored-domain-positive", [
      "src/origin-check.ts",
      "src/config.ts",
      "src/handler.ts",
    ]);
    const owner = projectFiles[0];
    expect(owner).toBeDefined();
    if (!owner) return;
    const candidate = extractCandidates(owner.filePath, owner.source)
      .find(({ source }) => source.includes("function acceptsOrigin"));
    expect(candidate).toBeDefined();
    if (!candidate) return;

    const evidence = buildUnanchoredDomainCheckEvidence(candidate, projectFiles);

    expect(evidence).toMatchObject({
      function: { name: "acceptsOrigin", exported: true },
      checks: [{
        method: "indexOf",
        anchored: false,
        dotBoundary: false,
        hostLike: true,
        source: expect.stringContaining("allowedOrigin"),
      }],
      urlParsed: false,
      repository: {
        callers: [expect.objectContaining({ filePath: "src/handler.ts" })],
        relatedModules: [expect.objectContaining({ filePath: "src/config.ts" })],
      },
    });
  });

  it("records URL parsing and dot-boundary matching as anchoring signals", async () => {
    const projectFiles = await project("unanchored-domain-negative", [
      "src/origin-check.ts",
      "src/config.ts",
      "src/handler.ts",
    ]);
    const owner = projectFiles[0];
    expect(owner).toBeDefined();
    if (!owner) return;
    const candidate = extractCandidates(owner.filePath, owner.source)
      .find(({ source }) => source.includes("function acceptsOrigin"));
    expect(candidate).toBeDefined();
    if (!candidate) return;

    expect(buildUnanchoredDomainCheckEvidence(candidate, projectFiles)).toMatchObject({
      checks: [expect.objectContaining({ method: "endsWith", dotBoundary: true })],
      urlParsed: true,
    });
  });

  it("abstains when substring matching never touches host-like values", () => {
    const source = `
      export function hasTodo(path: string): boolean {
        return path.includes("/todos/");
      }
    `;
    const candidate = extractCandidates("src/path.ts", source)[0];
    expect(candidate).toBeDefined();
    if (!candidate) return;

    expect(buildUnanchoredDomainCheckEvidence(
      candidate,
      [{ filePath: "src/path.ts", source }],
    )).toBeUndefined();
  });
});
