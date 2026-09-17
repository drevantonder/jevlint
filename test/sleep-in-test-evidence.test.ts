import { readFile } from "node:fs/promises";
import { describe, expect, it } from "vitest";
import { extractCandidates } from "../src/candidates.js";
import { buildSleepInTestEvidence } from "../src/evidence/sleep-in-test.js";
import type { ProjectFile } from "../src/types.js";

const repositories = new URL("./fixtures/repositories/", import.meta.url);

async function project(name: string, paths: string[]): Promise<ProjectFile[]> {
  return Promise.all(paths.map(async (filePath) => ({
    filePath,
    source: await readFile(new URL(`${name}/${filePath}`, repositories), "utf8"),
  })));
}

describe("sleep in test evidence", () => {
  it("flags a fixed sleep before asserting an async outcome", async () => {
    const projectFiles = await project("sleep-positive", ["test/search.test.ts"]);
    const owner = projectFiles[0];
    expect(owner).toBeDefined();
    if (!owner) return;
    const candidate = extractCandidates(owner.filePath, owner.source)
      .filter(({ kind, source }) => kind === "function" && source.includes("sleep(2000)"))
      .sort((left, right) => left.source.length - right.source.length)[0];
    expect(candidate).toBeDefined();
    if (!candidate) return;

    expect(buildSleepInTestEvidence(candidate, projectFiles)).toMatchObject({
      sleepCalls: [{ kind: "sleep", durationMs: 2000 }],
      pollingHelpers: [],
      maybeDurationSubject: false,
    });
  });

  it("abstains for a sleep helper that is not itself a test", async () => {
    const projectFiles = await project("sleep-positive", ["test/search.test.ts"]);
    const owner = projectFiles[0];
    expect(owner).toBeDefined();
    if (!owner) return;
    const candidate = extractCandidates(owner.filePath, owner.source)
      .filter(({ kind, source }) => kind === "function" && source.includes("setTimeout(resolve"))
      .sort((left, right) => left.source.length - right.source.length)[0];
    expect(candidate).toBeDefined();
    if (!candidate) return;

    expect(buildSleepInTestEvidence(candidate, projectFiles)).toBeUndefined();
  });

  it("abstains when the test awaits a polling helper", async () => {
    const projectFiles = await project("sleep-negative", ["test/search.test.ts"]);
    const owner = projectFiles[0];
    expect(owner).toBeDefined();
    if (!owner) return;
    const candidate = extractCandidates(owner.filePath, owner.source)
      .filter(({ kind, source }) => kind === "function" && source.includes("waitFor(eventuallyReady)"))
      .sort((left, right) => left.source.length - right.source.length)[0];
    expect(candidate).toBeDefined();
    if (!candidate) return;

    expect(buildSleepInTestEvidence(candidate, projectFiles)).toBeUndefined();
  });

  it("marks a delay that tests a debounce duration as the subject", async () => {
    const projectFiles = await project("sleep-debounce", ["test/debounce.test.ts"]);
    const owner = projectFiles[0];
    expect(owner).toBeDefined();
    if (!owner) return;
    const candidate = extractCandidates(owner.filePath, owner.source)
      .filter(({ kind, source }) => kind === "function" && source.includes("delay(150)"))
      .sort((left, right) => left.source.length - right.source.length)[0];
    expect(candidate).toBeDefined();
    if (!candidate) return;

    expect(buildSleepInTestEvidence(candidate, projectFiles)).toMatchObject({
      sleepCalls: [expect.objectContaining({ kind: "delay" })],
      maybeDurationSubject: true,
    });
  });
});
