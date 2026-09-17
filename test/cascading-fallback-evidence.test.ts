import { readFile } from "node:fs/promises";
import { describe, expect, it } from "vitest";
import { extractCandidates } from "../src/candidates.js";
import { buildCascadingFallbackEvidence } from "../src/evidence/cascading-fallback.js";
import type { Candidate, ProjectFile } from "../src/types.js";

async function project(name: string, paths: string[]): Promise<ProjectFile[]> {
  return Promise.all(paths.map(async (filePath) => ({
    filePath,
    source: await readFile(
      new URL(`./fixtures/repositories/${name}/${filePath}`, import.meta.url),
      "utf8",
    ),
  })));
}

function candidateFor(files: ProjectFile[], filePath: string, marker: string): Candidate | undefined {
  const file = files.find((entry) => entry.filePath === filePath);
  expect(file).toBeDefined();
  if (!file) return undefined;
  const candidate = extractCandidates(file.filePath, file.source)
    .find(({ kind, source }) => kind === "function" && source.includes(marker));
  expect(candidate).toBeDefined();
  return candidate;
}

describe("cascading fallback evidence", () => {
  it("shows Jev the primary and fallback calls sharing one pool", async () => {
    const files = await project("cascading-fallback-positive", [
      "src/fetch-user.ts",
      "src/db.ts",
      "src/caller.ts",
    ]);
    const candidate = candidateFor(files, "src/fetch-user.ts", "fetchUser");
    if (!candidate) return;

    const evidence = buildCascadingFallbackEvidence(candidate, files);

    expect(evidence).toMatchObject({
      function: {
        name: "fetchUser",
        exported: true,
        source: expect.stringContaining("pool.query"),
      },
      handlers: [
        {
          primaryCalls: [{ root: "pool", importedFrom: "./db.js" }],
          fallbackCalls: [{ root: "pool", importedFrom: "./db.js" }],
          sharedDependencies: [
            { root: "pool", importedFrom: "./db.js" },
          ],
          fallbackReturnsStatic: false,
        },
      ],
      repository: {
        callers: [{ filePath: "src/caller.ts" }],
      },
    });
  });

  it("reports the degraded cache fallback with no shared capability", async () => {
    const files = await project("cascading-fallback-negative", [
      "src/fetch-user.ts",
      "src/db.ts",
    ]);
    const candidate = candidateFor(files, "src/fetch-user.ts", "fetchUser");
    if (!candidate) return;

    const evidence = buildCascadingFallbackEvidence(candidate, files);

    expect(evidence).toMatchObject({
      handlers: [
        {
          fallbackCalls: [{ root: "staticCache", importedFrom: null }],
          sharedDependencies: [],
          fallbackReturnsStatic: true,
        },
      ],
    });
  });

  it("abstains when the fallback returns without invoking any capability", () => {
    const source = `export async function fetchUser(id: number): Promise<unknown> {
      try {
        return await loadUser(id);
      } catch {
        return { id, name: "unknown" };
      }
    }`;
    const candidate = extractCandidates("src/fetch-user.ts", source)
      .find(({ kind }) => kind === "function");
    expect(candidate).toBeDefined();
    if (!candidate) return;

    expect(buildCascadingFallbackEvidence(candidate, [{ filePath: "src/fetch-user.ts", source }]))
      .toBeUndefined();
  });

  it("abstains when the function has no catch block", () => {
    const source = `export async function fetchUser(id: number): Promise<unknown> {
      return { id };
    }`;
    const candidate = extractCandidates("src/fetch-user.ts", source)
      .find(({ kind }) => kind === "function");
    expect(candidate).toBeDefined();
    if (!candidate) return;

    expect(buildCascadingFallbackEvidence(candidate, [{ filePath: "src/fetch-user.ts", source }]))
      .toBeUndefined();
  });
});
