import { readFile } from "node:fs/promises";
import { describe, expect, it } from "vitest";
import { defaultConfig } from "../src/config.js";
import { extractCandidates } from "../src/candidates.js";
import { buildRuleEvidence } from "../src/evidence/index.js";
import { buildHandRolledConcurrencyLimitEvidence } from "../src/evidence/hand-rolled-concurrency-limit.js";
import type { Candidate, ProjectFile } from "../src/types.js";

const RULE = "jev/no-hand-rolled-concurrency-limit";
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

describe("hand rolled concurrency limit wiring", () => {
  it("ships as a function judgment without thresholds", () => {
    expect(defaultConfig.rules[RULE]).toMatchObject({
      scope: "function",
      message: expect.any(String),
    });
    expect(defaultConfig.rules[RULE]).not.toHaveProperty("threshold");
    expect(defaultConfig.rules[RULE]).not.toHaveProperty("severity");
  });

  it("flags a counter-queue limiter beside an installed limiter", async () => {
    const files = await project("hand-rolled-concurrency-limit-positive", [
      "package.json",
      "src/pool.ts",
      "src/jobs.ts",
    ]);

    const result = buildRuleEvidence(
      RULE,
      functionCandidate(files, "pool", "runWithLimit"),
      files,
    );

    expect(result).toEqual({ handled: true, evidence: expect.any(Object) });
    if (!result.handled) return;
    expect(result.evidence).toMatchObject({
      ownedLimiterDep: "p-limit",
      siblingImporters: ["src/jobs.ts"],
      signals: expect.arrayContaining([
        expect.objectContaining({ signal: "active-counter" }),
        expect.objectContaining({ signal: "waiting-queue" }),
      ]),
    });
  });

  it("abstains without an installed limiter", () => {
    const source = `export function runWithLimit(tasks: Array<() => Promise<void>>, limit: number): void {
  let active = 0;
  const queue = [...tasks];
  while (active < limit && queue.length > 0) {
    const task = queue.shift();
    active += 1;
    void task;
  }
}
`;
    const candidate = extractCandidates("src/pool.ts", source)
      .find((entry) => entry.kind === "function");
    expect(candidate).toBeDefined();
    if (!candidate) return;
    expect(buildHandRolledConcurrencyLimitEvidence(candidate, [
      { filePath: "package.json", source: JSON.stringify({ dependencies: {} }) },
      { filePath: "src/pool.ts", source },
    ])).toBeUndefined();
  });

  it("abstains for a counter without a waiting queue", () => {
    const source = `export async function runAll(tasks: Array<() => Promise<void>>): Promise<void> {
  let active = 0;
  for (const task of tasks) {
    active += 1;
    await task();
    active -= 1;
  }
}
`;
    const candidate = extractCandidates("src/pool.ts", source)
      .find((entry) => entry.kind === "function");
    expect(candidate).toBeDefined();
    if (!candidate) return;
    expect(buildHandRolledConcurrencyLimitEvidence(candidate, [
      { filePath: "package.json", source: JSON.stringify({ dependencies: { "p-limit": "^5.0.0" } }) },
      { filePath: "src/pool.ts", source },
    ])).toBeUndefined();
  });
});
