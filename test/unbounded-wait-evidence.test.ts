import { readFile } from "node:fs/promises";
import { describe, expect, it } from "vitest";
import { extractCandidates } from "../src/candidates.js";
import { buildUnboundedWaitEvidence } from "../src/evidence/unbounded-wait.js";
import type { ProjectFile } from "../src/types.js";

const repositories = new URL("./fixtures/repositories/", import.meta.url);

async function project(name: string, paths: string[]): Promise<ProjectFile[]> {
  return Promise.all(paths.map(async (filePath) => ({
    filePath,
    source: await readFile(new URL(`${name}/${filePath}`, repositories), "utf8"),
  })));
}

describe("unbounded wait evidence", () => {
  it("flags a bare fetch without signal, timeout, or module abort control", async () => {
    const projectFiles = await project("unbounded-wait-positive", [
      "src/fetch-user.ts",
      "src/handler.ts",
    ]);
    const owner = projectFiles[0];
    expect(owner).toBeDefined();
    if (!owner) return;
    const candidate = extractCandidates(owner.filePath, owner.source)
      .find(({ source }) => source.includes("function fetchUser"));
    expect(candidate).toBeDefined();
    if (!candidate) return;

    expect(buildUnboundedWaitEvidence(candidate, projectFiles)).toMatchObject({
      function: { name: "fetchUser", exported: true },
      waitCalls: [{
        client: "fetch",
        kind: "fetch",
        hasTimeoutOption: false,
        hasSignal: false,
        importedFrom: null,
      }],
      abortControlInScope: false,
      repository: {
        callers: [expect.objectContaining({ filePath: "src/handler.ts" })],
      },
    });
  });

  it("notes a one-hop wrapper that already sets a default bound", async () => {
    const projectFiles = await project("unbounded-wait-ambiguous", [
      "src/fetch-user.ts",
      "src/http.ts",
    ]);
    const owner = projectFiles[0];
    expect(owner).toBeDefined();
    if (!owner) return;
    const candidate = extractCandidates(owner.filePath, owner.source)
      .find(({ source }) => source.includes("function fetchUser"));
    expect(candidate).toBeDefined();
    if (!candidate) return;

    expect(buildUnboundedWaitEvidence(candidate, projectFiles)).toMatchObject({
      waitCalls: [{
        kind: "project-wrapper",
        hasTimeoutOption: true,
        wrapperPolicy: expect.stringContaining("sets a default bound"),
        targetModule: expect.objectContaining({ filePath: "src/http.ts" }),
      }],
    });
  });

  it("abstains when the fetch carries an explicit signal", async () => {
    const projectFiles = await project("unbounded-wait-negative", ["src/fetch-user.ts"]);
    const owner = projectFiles[0];
    expect(owner).toBeDefined();
    if (!owner) return;
    const candidate = extractCandidates(owner.filePath, owner.source)
      .find(({ source }) => source.includes("function fetchUser"));
    expect(candidate).toBeDefined();
    if (!candidate) return;

    expect(buildUnboundedWaitEvidence(candidate, projectFiles)).toBeUndefined();
  });

  it("abstains when no network call is present", () => {
    const source = `
      export function add(a: number, b: number) {
        return a + b;
      }
    `;
    const candidate = extractCandidates("src/add.ts", source)[0];
    expect(candidate).toBeDefined();
    if (!candidate) return;

    expect(buildUnboundedWaitEvidence(
      candidate,
      [{ filePath: "src/add.ts", source }],
    )).toBeUndefined();
  });
});
