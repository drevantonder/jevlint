import { readFile } from "node:fs/promises";
import { describe, expect, it } from "vitest";
import { defaultConfig } from "../src/config.js";
import { extractCandidates } from "../src/candidates.js";
import { buildRuleEvidence } from "../src/evidence/index.js";
import { buildHandRolledRetryLoopEvidence } from "../src/evidence/hand-rolled-retry-loop.js";
import type { Candidate, ProjectFile } from "../src/types.js";

const RULE = "jev/no-hand-rolled-retry-loop";
const repositories = new URL("./fixtures/repositories/", import.meta.url);

async function project(name: string, paths: string[]): Promise<ProjectFile[]> {
  return Promise.all(paths.map(async (filePath) => ({
    filePath,
    source: await readFile(new URL(`${name}/${filePath}`, repositories), "utf8"),
  })));
}

function functionCandidate(files: ProjectFile[], filePart: string, name: string): Candidate {
  const owner = files.find((file) => file.filePath.includes(filePart));
  expect(owner).toBeDefined();
  if (!owner) throw new Error("Fixture has no candidate file.");
  const candidate = extractCandidates(owner.filePath, owner.source)
    .find((entry) => entry.kind === "function" && entry.source.includes(name));
  expect(candidate).toBeDefined();
  if (!candidate) throw new Error(`Fixture has no function containing ${name}.`);
  return candidate;
}

describe("hand rolled retry loop wiring", () => {
  it("ships as a function judgment without thresholds", () => {
    expect(defaultConfig.rules[RULE]).toMatchObject({
      scope: "function",
      message: expect.any(String),
    });
    expect(defaultConfig.rules[RULE]).not.toHaveProperty("threshold");
    expect(defaultConfig.rules[RULE]).not.toHaveProperty("severity");
  });

  it("flags a backoff loop beside an installed retry dep", async () => {
    const files = await project("hand-rolled-retry-loop-positive", [
      "package.json",
      "src/fetch-with-retry.ts",
      "src/client.ts",
    ]);

    const result = buildRuleEvidence(
      RULE,
      functionCandidate(files, "fetch-with-retry", "fetchWithRetry"),
      files,
    );

    expect(result).toEqual({ handled: true, evidence: expect.any(Object) });
    if (!result.handled) return;
    expect(result.evidence).toMatchObject({
      ownedRetryDep: "p-retry",
      siblingImporters: ["src/client.ts"],
      hasJitter: true,
    });
  });

  it("abstains without an installed retry dep", () => {
    const source = `async function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
export async function fetchOnce(url: string): Promise<string> {
  for (let attempt = 0; attempt < 3; attempt += 1) {
    try {
      return await (await fetch(url)).text();
    } catch {
      await sleep(100);
    }
  }
  throw new Error("unreachable");
}
`;
    const candidate = extractCandidates("src/fetch.ts", source)
      .find((entry) => entry.kind === "function" && entry.source.includes("fetchOnce"));
    expect(candidate).toBeDefined();
    if (!candidate) return;
    expect(buildHandRolledRetryLoopEvidence(candidate, [
      { filePath: "package.json", source: JSON.stringify({ dependencies: {} }) },
      { filePath: "src/fetch.ts", source },
    ])).toBeUndefined();
  });

  it("abstains for a loop without a delay", () => {
    const source = `export async function poll(url: string): Promise<string> {
  for (let attempt = 0; attempt < 3; attempt += 1) {
    try {
      return await (await fetch(url)).text();
    } catch {
      continue;
    }
  }
  throw new Error("unreachable");
}
`;
    const candidate = extractCandidates("src/fetch.ts", source)
      .find((entry) => entry.kind === "function");
    expect(candidate).toBeDefined();
    if (!candidate) return;
    expect(buildHandRolledRetryLoopEvidence(candidate, [
      { filePath: "package.json", source: JSON.stringify({ dependencies: { "p-retry": "^5.0.0" } }) },
      { filePath: "src/fetch.ts", source },
    ])).toBeUndefined();
  });
});
