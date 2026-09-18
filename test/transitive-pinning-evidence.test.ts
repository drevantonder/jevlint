import { readFile } from "node:fs/promises";
import { describe, expect, it } from "vitest";
import { analyzeFileWithFailures } from "../src/analyze.js";
import { extractCandidates } from "../src/candidates.js";
import { defaultConfig } from "../src/defaults.js";
import { findTransitiveTestPins } from "../src/evidence/test-scope.js";
import { buildUnpinnedBoundaryBranchEvidence } from "../src/evidence/unpinned-boundary-branch.js";
import { buildUnpinnedCompatQuirkEvidence } from "../src/evidence/unpinned-compat-quirk.js";
import { buildUnpinnedFailurePathEvidence } from "../src/evidence/unpinned-failure-path.js";
import type {
  Candidate,
  EvaluationRequest,
  Evaluator,
  JevLintConfig,
  ProjectFile,
} from "../src/types.js";

const repositories = new URL("./fixtures/repositories/", import.meta.url);

const CANDIDATE = `export function walkEntries(entries: string[]): string[] {
  if (entries.length === 0) {
    throw new Error("walkEntries: no entries");
  }
  const head = entries[0] as string;
  if (head === "root") {
    return [head];
  }
  if (entries.length > 100) {
    return entries.slice(0, 100);
  }
  return entries.map((entry) => entry.trim());
}
`;

const SEAM = `import { walkEntries } from "./walk.js";
export function collectEntries(entries: string[]): string[] {
  return walkEntries(entries);
}
`;

const SEAM_TEST = `import { test, expect } from "vitest";
import { collectEntries } from "../src/seam.js";
test("collects entries through the seam", () => {
  expect(collectEntries(["a"])).toEqual(["a"]);
});
`;

const DIRECT_TEST = `import { test, expect } from "vitest";
import { walkEntries } from "../src/walk.js";
test("walks entries directly", () => {
  expect(walkEntries(["a"])).toEqual(["a"]);
});
`;

const OTHER = `export function unrelated(): number {
  return 1;
}
`;

const ANONYMOUS_SEAM = `import { walkEntries } from "./walk.js";
export const collected: string[] = walkEntries(["a"]);
`;

const EXPECTED_CHAIN = {
  test: "test/collect.test.ts",
  seam: "collectEntries",
  seamFile: "src/seam.ts",
  candidate: "walkEntries",
};

function seamProject(): ProjectFile[] {
  return [
    { filePath: "src/walk.ts", source: CANDIDATE },
    { filePath: "src/seam.ts", source: SEAM },
    { filePath: "test/collect.test.ts", source: SEAM_TEST },
  ];
}

function candidateFor(source: string, filePath: string): Candidate {
  const found = extractCandidates(filePath, source)
    .find(({ kind, source: text }) => kind === "function" && text.includes("walkEntries"));
  expect(found).toBeDefined();
  if (!found) throw new Error("candidate missing");
  return found;
}

describe("transitive pinning evidence", () => {
  it("names the test → seam → candidate chain", () => {
    expect(findTransitiveTestPins("src/walk.ts", "walkEntries", seamProject())).toEqual([
      expect.objectContaining(EXPECTED_CHAIN),
    ]);
  });

  it("returns no chain for direct pinning or no pinning", () => {
    const direct: ProjectFile[] = [
      { filePath: "src/walk.ts", source: CANDIDATE },
      { filePath: "test/walk.test.ts", source: DIRECT_TEST },
    ];
    expect(findTransitiveTestPins("src/walk.ts", "walkEntries", direct)).toEqual([]);

    const unpinned: ProjectFile[] = [
      { filePath: "src/walk.ts", source: CANDIDATE },
      { filePath: "src/other.ts", source: OTHER },
    ];
    expect(findTransitiveTestPins("src/walk.ts", "walkEntries", unpinned)).toEqual([]);
  });

  it("reports no chain when the seam call has no nameable seam", () => {
    const projectFiles: ProjectFile[] = [
      { filePath: "src/walk.ts", source: CANDIDATE },
      { filePath: "src/collected.ts", source: ANONYMOUS_SEAM },
    ];
    expect(findTransitiveTestPins("src/walk.ts", "walkEntries", projectFiles)).toEqual([]);
  });

  it("adds the named chain to failure-path pinning for the seam-tested candidate", () => {
    const projectFiles = seamProject();
    const evidence = buildUnpinnedFailurePathEvidence(
      candidateFor(CANDIDATE, "src/walk.ts"),
      projectFiles,
    );

    expect(evidence?.pinning.testReferences).toEqual([]);
    expect(evidence?.pinning.transitivePins).toEqual([
      expect.objectContaining({ ...EXPECTED_CHAIN, seamCall: expect.stringContaining("collectEntries") }),
    ]);
  });

  it("adds the named chain to boundary-branch pinning for the seam-tested candidate", () => {
    const projectFiles = seamProject();
    const evidence = buildUnpinnedBoundaryBranchEvidence(
      candidateFor(CANDIDATE, "src/walk.ts"),
      projectFiles,
    );

    expect(evidence?.pinning.testReferences).toEqual([]);
    expect(evidence?.pinning.transitivePins).toEqual([
      expect.objectContaining(EXPECTED_CHAIN),
    ]);
  });

  it("adds the named chain to compat-quirk pinning for the seam-tested candidate", () => {
    const projectFiles = seamProject();
    const evidence = buildUnpinnedCompatQuirkEvidence(
      candidateFor(CANDIDATE, "src/walk.ts"),
      projectFiles,
    );

    expect(evidence?.pinning.testReferences).toEqual([]);
    expect(evidence?.pinning.transitivePins).toEqual([
      expect.objectContaining(EXPECTED_CHAIN),
    ]);
  });

  it("leaves direct-pinned and unpinned pinning without the transitive key", () => {
    const direct: ProjectFile[] = [
      { filePath: "src/walk.ts", source: CANDIDATE },
      { filePath: "test/walk.test.ts", source: DIRECT_TEST },
    ];
    const candidate = candidateFor(CANDIDATE, "src/walk.ts");

    const directFailure = buildUnpinnedFailurePathEvidence(candidate, direct);
    expect(directFailure?.pinning.testReferences).toEqual(["test/walk.test.ts"]);
    expect(directFailure?.pinning).not.toHaveProperty("transitivePins");

    const directBoundary = buildUnpinnedBoundaryBranchEvidence(candidate, direct);
    expect(directBoundary?.pinning.testReferences).toEqual(["test/walk.test.ts"]);
    expect(directBoundary?.pinning).not.toHaveProperty("transitivePins");

    const directQuirk = buildUnpinnedCompatQuirkEvidence(candidate, direct);
    expect(directQuirk?.pinning.testReferences).toEqual(["test/walk.test.ts"]);
    expect(directQuirk?.pinning).not.toHaveProperty("transitivePins");

    const unpinned: ProjectFile[] = [
      { filePath: "src/walk.ts", source: CANDIDATE },
      { filePath: "src/other.ts", source: OTHER },
    ];
    expect(buildUnpinnedFailurePathEvidence(candidate, unpinned)?.pinning)
      .not.toHaveProperty("transitivePins");
    expect(buildUnpinnedBoundaryBranchEvidence(candidate, unpinned)?.pinning)
      .not.toHaveProperty("transitivePins");

    const callerWithoutTest: ProjectFile[] = [
      { filePath: "src/walk.ts", source: CANDIDATE },
      { filePath: "src/seam.ts", source: SEAM },
    ];
    expect(buildUnpinnedCompatQuirkEvidence(candidate, callerWithoutTest)?.pinning)
      .not.toHaveProperty("transitivePins");
  });

  it("leaves the pre-existing direct-pinned failure fixture without the transitive key", async () => {
    const projectFiles = await Promise.all(
      ["src/charge.ts", "src/gateway.ts", "test/charge.test.ts"].map(async (filePath) => ({
        filePath,
        source: await readFile(new URL(`failure-negative/${filePath}`, repositories), "utf8"),
      })),
    );
    const owner = projectFiles[0];
    expect(owner).toBeDefined();
    if (!owner) return;
    const candidate = extractCandidates(owner.filePath, owner.source)
      .find(({ kind, source }) => kind === "function" && source.includes("chargeCard"));
    expect(candidate).toBeDefined();
    if (!candidate) return;

    const evidence = buildUnpinnedFailurePathEvidence(candidate, projectFiles);
    expect(evidence?.pinning.testReferences).toEqual(["test/charge.test.ts"]);
    expect(evidence?.pinning).not.toHaveProperty("transitivePins");
  });

  it("carries the named chain through a fake evaluator with raw scores", async () => {
    const projectFiles = seamProject();
    const owner = projectFiles[0];
    expect(owner).toBeDefined();
    if (!owner) return;
    const rule = defaultConfig.rules["jev/no-unpinned-failure-path"];
    expect(rule).toBeDefined();
    if (!rule) return;
    const config: JevLintConfig = { rules: { "jev/no-unpinned-failure-path": rule } };
    const evaluator: Evaluator = {
      async evaluate(request: EvaluationRequest): Promise<Record<string, number>> {
        return Object.fromEntries(Object.keys(request.questions).map((id) => [id, 0.71]));
      },
    };

    const result = await analyzeFileWithFailures({
      filePath: "src/walk.ts",
      source: owner.source,
      changedLines: [{ start: 1, end: owner.source.split("\n").length }],
      config,
      projectFiles,
    }, evaluator);

    expect(result.failures).toEqual([]);
    expect(result.judgments.map((judgment) => judgment.probability)).toEqual([0.71]);
    const judged = result.judgments[0];
    expect(judged?.ruleId).toBe("jev/no-unpinned-failure-path");
    // SAFETY: rule evidence is a JSON object and this builder sets pinning on every firing.
    const evidence = judged?.evidence as {
      pinning?: { transitivePins?: { test: string; seam: string; seamFile: string; candidate: string }[] };
    } | null;
    expect(evidence?.pinning?.transitivePins).toEqual([
      expect.objectContaining(EXPECTED_CHAIN),
    ]);
  });
});
