import { describe, expect, it } from "vitest";
import { extractCandidates } from "../src/candidates.js";
import { buildRuleEvidence } from "../src/evidence/index.js";
import { buildCheckThenActRaceEvidence } from "../src/evidence/check-then-act-race.js";
import type { Candidate, ProjectFile } from "../src/types.js";

const racy = `export async function getOrBuild(key: string) {
  if (!cache.has(key)) {
    const value = await build(key);
    cache.set(key, value);
  }
  return cache.get(key);
}
`;

const guarded = `export async function getOrBuild(key: string) {
  if (!cache.has(key)) {
    await lock.acquire();
    try {
      const value = await build(key);
      cache.set(key, value);
    } finally {
      lock.release();
    }
  }
  return cache.get(key);
}
`;

const sequential = `export function getOrBuild(key: string) {
  if (!cache.has(key)) {
    cache.set(key, buildSync(key));
  }
  return cache.get(key);
}
`;

function candidateFor(source: string, filePath: string, snippet: string): Candidate {
  const found = extractCandidates(filePath, source)
    .find(({ kind, source: text }) => kind === "function" && text.includes(snippet));
  expect(found).toBeDefined();
  expect(found?.kind).toBe("function");
  if (!found) throw new Error("candidate missing");
  return found;
}

describe("check-then-act race evidence", () => {
  it("connects the check, the await gap, and the same-resource mutation", () => {
    const projectFiles: ProjectFile[] = [{ filePath: "src/cache.ts", source: racy }];
    const candidate = candidateFor(racy, "src/cache.ts", "function getOrBuild");

    const evidence = buildCheckThenActRaceEvidence(candidate, projectFiles);

    expect(evidence).toMatchObject({
      function: { name: "getOrBuild", exported: true },
      sequences: [{
        check: expect.stringContaining("cache.has"),
        interveningAwaits: [expect.stringContaining("await build")],
        mutation: expect.stringContaining("cache.set"),
        sameResource: true,
      }],
      atomicSignals: [],
    });
  });

  it("surfaces atomic guards so the judgment can score low", () => {
    const projectFiles: ProjectFile[] = [{ filePath: "src/cache.ts", source: guarded }];
    const candidate = candidateFor(guarded, "src/cache.ts", "function getOrBuild");

    const evidence = buildCheckThenActRaceEvidence(candidate, projectFiles);

    expect(evidence?.sequences.length).toBeGreaterThan(0);
    expect(evidence?.atomicSignals).toContain("lock");
  });

  it("abstains when no await separates the check from the mutation", () => {
    const candidate = candidateFor(sequential, "src/cache.ts", "function getOrBuild");

    expect(buildCheckThenActRaceEvidence(candidate, [{ filePath: "src/cache.ts", source: sequential }]))
      .toBeUndefined();
  });

  it("abstains for non-function candidates", () => {
    const comment = { ...candidateFor(racy, "src/cache.ts", "function getOrBuild"), kind: "comment" as const };
    expect(buildCheckThenActRaceEvidence(comment, [{ filePath: "src/cache.ts", source: racy }]))
      .toBeUndefined();
  });

  it("dispatches through the rule registry", () => {
    const projectFiles: ProjectFile[] = [{ filePath: "src/cache.ts", source: racy }];
    const candidate = candidateFor(racy, "src/cache.ts", "function getOrBuild");

    const result = buildRuleEvidence("jev/no-check-then-act-race", candidate, projectFiles);

    expect(result.handled).toBe(true);
    expect(result.handled && result.evidence).toBeDefined();
  });
});
