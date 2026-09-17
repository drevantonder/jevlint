import { readFile } from "node:fs/promises";
import { describe, expect, it } from "vitest";
import { extractCandidates } from "../src/candidates.js";
import { buildUnenforcedWarningCommentEvidence } from "../src/evidence/unenforced-warning-comment.js";
import type { ProjectFile } from "../src/types.js";

const repositories = new URL("./fixtures/repositories/", import.meta.url);

async function project(name: string, paths: string[]): Promise<ProjectFile[]> {
  return Promise.all(paths.map(async (filePath) => ({
    filePath,
    source: await readFile(new URL(`${name}/${filePath}`, repositories), "utf8"),
  })));
}

function warningComment(files: ProjectFile[]): ReturnType<typeof extractCandidates>[number] {
  const owner = files[0];
  expect(owner).toBeDefined();
  if (!owner) throw new Error("Fixture has no changed file.");
  const candidate = extractCandidates(owner.filePath, owner.source)
    .find(({ kind, source }) => kind === "comment" && source.includes("must call"));
  expect(candidate).toBeDefined();
  if (!candidate) throw new Error("Fixture has no warning comment.");
  return candidate;
}

describe("unenforced warning comment evidence", () => {
  it("extracts the hazard admission, the unguarded function, and the violating caller", async () => {
    const files = await project("unenforced-warning-comment-positive", [
      "src/runner.ts",
      "src/app.ts",
    ]);

    const evidence = buildUnenforcedWarningCommentEvidence(warningComment(files), files);

    expect(evidence).toMatchObject({
      hazardMatches: [
        { pattern: "must-call-first" },
      ],
      enclosingFunction: {
        name: "run",
      },
      guards: [],
      callers: [
        expect.objectContaining({ filePath: "src/app.ts" }),
      ],
    });
  });

  it("retains the enforcing guard beside the warning", async () => {
    const files = await project("unenforced-warning-comment-negative", ["src/runner.ts"]);

    const evidence = buildUnenforcedWarningCommentEvidence(warningComment(files), files);

    expect(evidence?.guards).toEqual([
      expect.stringContaining("if (!initialized)"),
    ]);
  });

  it("abstains for comments that admit no hazard", () => {
    const source = `export function next(count: number): number {
      // Increment the counter
      return count + 1;
    }`;
    const candidate = extractCandidates("src/next.ts", source)
      .find(({ kind }) => kind === "comment");
    expect(candidate).toBeDefined();
    if (!candidate) return;

    expect(buildUnenforcedWarningCommentEvidence(
      candidate,
      [{ filePath: "src/next.ts", source }],
    )).toBeUndefined();
  });

  it("abstains for function candidates", async () => {
    const files = await project("unenforced-warning-comment-positive", ["src/runner.ts"]);
    const owner = files[0];
    expect(owner).toBeDefined();
    if (!owner) return;
    const candidate = extractCandidates(owner.filePath, owner.source)
      .find(({ kind }) => kind === "function");
    expect(candidate).toBeDefined();
    if (!candidate) return;

    expect(buildUnenforcedWarningCommentEvidence(
      candidate,
      files,
    )).toBeUndefined();
  });
});
