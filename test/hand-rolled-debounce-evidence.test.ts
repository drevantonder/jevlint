import { readFile } from "node:fs/promises";
import { describe, expect, it } from "vitest";
import { defaultConfig } from "../src/config.js";
import { extractCandidates } from "../src/candidates.js";
import { buildRuleEvidence } from "../src/evidence/index.js";
import { buildHandRolledDebounceEvidence } from "../src/evidence/hand-rolled-debounce.js";
import type { Candidate, ProjectFile } from "../src/types.js";

const RULE = "jev/no-hand-rolled-debounce";
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

describe("hand rolled debounce wiring", () => {
  it("ships as a function judgment without thresholds", () => {
    expect(defaultConfig.rules[RULE]).toMatchObject({
      scope: "function",
      message: expect.any(String),
    });
    expect(defaultConfig.rules[RULE]).not.toHaveProperty("threshold");
    expect(defaultConfig.rules[RULE]).not.toHaveProperty("severity");
  });

  it("flags a full-option wrapper beside an installed debounce dep", async () => {
    const files = await project("hand-rolled-debounce-positive", [
      "package.json",
      "src/search.ts",
      "src/input.ts",
    ]);

    const result = buildRuleEvidence(
      RULE,
      functionCandidate(files, "search", "debounce"),
      files,
    );

    expect(result).toEqual({ handled: true, evidence: expect.any(Object) });
    if (!result.handled) return;
    expect(result.evidence).toMatchObject({
      ownedDebounceDep: "lodash.debounce",
      siblingImporters: ["src/input.ts"],
      optionCount: 5,
    });
  });

  it("abstains without an installed debounce dep", () => {
    const source = `export function debounce(fn: () => void, wait: number): () => void {
  let timer: ReturnType<typeof setTimeout> | null = null;
  return () => {
    if (timer) clearTimeout(timer);
    timer = setTimeout(fn, wait);
  };
}
`;
    const candidate = extractCandidates("src/search.ts", source)
      .find((entry) => entry.kind === "function");
    expect(candidate).toBeDefined();
    if (!candidate) return;
    expect(buildHandRolledDebounceEvidence(candidate, [
      { filePath: "package.json", source: JSON.stringify({ dependencies: {} }) },
      { filePath: "src/search.ts", source },
    ])).toBeUndefined();
  });

  it("abstains for a bare timeout without timer reset", () => {
    const source = `export function later(fn: () => void): void {
  setTimeout(fn, 100);
}
`;
    const candidate = extractCandidates("src/search.ts", source)
      .find((entry) => entry.kind === "function");
    expect(candidate).toBeDefined();
    if (!candidate) return;
    expect(buildHandRolledDebounceEvidence(candidate, [
      { filePath: "package.json", source: JSON.stringify({ dependencies: { lodash: "^4.0.0" } }) },
      { filePath: "src/search.ts", source },
    ])).toBeUndefined();
  });
});
