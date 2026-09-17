import { readFile } from "node:fs/promises";
import { describe, expect, it } from "vitest";
import { analyzeFileWithFailures } from "../src/analyze.js";
import { extractCandidates } from "../src/candidates.js";
import { defaultConfig } from "../src/config.js";
import { buildRuleEvidence } from "../src/evidence/index.js";
import { buildUnverifiedClaimEvidence } from "../src/evidence/unverified-claim.js";
import type {
  Candidate,
  EvaluationRequest,
  Evaluator,
  JevLintConfig,
  ProjectFile,
} from "../src/types.js";

const RULE = "jev/no-unverified-claim";
const repositories = new URL("./fixtures/repositories/", import.meta.url);

async function project(name: string, paths: string[]): Promise<ProjectFile[]> {
  return Promise.all(paths.map(async (filePath) => ({
    filePath,
    source: await readFile(new URL(`${name}/${filePath}`, repositories), "utf8"),
  })));
}

function commentCandidate(files: ProjectFile[], excerpt: string): Candidate {
  const owner = files[0];
  expect(owner).toBeDefined();
  if (!owner) throw new Error("Fixture has no changed file.");
  const candidate = extractCandidates(owner.filePath, owner.source)
    .find(({ kind, source }) => kind === "comment" && source.includes(excerpt));
  expect(candidate).toBeDefined();
  if (!candidate) throw new Error(`Fixture has no comment containing ${excerpt}.`);
  return candidate;
}

class StubEvaluator implements Evaluator {
  async evaluate(request: EvaluationRequest): Promise<Record<string, number>> {
    return Object.fromEntries(Object.keys(request.questions).map((id) => [id, 0.5]));
  }
}

describe("unverified claim wiring", () => {
  it("ships as a comment judgment without thresholds", () => {
    expect(defaultConfig.rules[RULE]).toMatchObject({
      scope: "comment",
      message: expect.any(String),
    });
    expect(defaultConfig.rules[RULE]).not.toHaveProperty("threshold");
    expect(defaultConfig.rules[RULE]).not.toHaveProperty("severity");
  });

  it("passes claim candidates through with the four evidence signals", async () => {
    const files = await project("hedging-comment-positive", ["src/parse.ts"]);

    const result = buildRuleEvidence(RULE, commentCandidate(files, "should handle"), files);

    expect(result).toEqual({ handled: true, evidence: expect.any(Object) });
    if (!result.handled) return;
    expect(result.evidence).toMatchObject({
      claimSignals: [{ signal: "handle-behavior" }],
      specificity: "vague",
      enclosingFunction: { name: "parseRow" },
      trackedWork: [],
      tone: { hedge: ["should"] },
    });
  });

  it("keeps the old hedging fixtures as candidates under the new rule", async () => {
    const positive = await project("hedging-comment-positive", ["src/parse.ts"]);
    const negative = await project("hedging-comment-negative", ["src/parse.ts"]);

    expect(buildUnverifiedClaimEvidence(
      commentCandidate(positive, "should handle"),
      positive,
    )).toBeDefined();
    expect(buildUnverifiedClaimEvidence(
      commentCandidate(negative, "Split on commas"),
      negative,
    )).toBeDefined();
  });

  it("discovers confident vagueness with no hedge words via claim structure", async () => {
    const files = await project("unverified-claim-evasion-positive", ["src/parse.ts"]);

    const evidence = buildUnverifiedClaimEvidence(
      commentCandidate(files, "edge cases"),
      files,
    );

    expect(evidence).toMatchObject({
      claimSignals: expect.arrayContaining([
        { signal: "handle-behavior", excerpt: "Handles" },
        { signal: "edge-cases", excerpt: "edge cases" },
      ]),
      specificity: "vague",
      callers: [],
      testPinning: [],
      trackedWork: [],
      tone: { hedge: [], reassurance: ["gracefully"] },
    });
  });

  it("records test pinning and tracked-work pointers as evidence", async () => {
    const files = await project("unverified-claim-pinned-negative", [
      "src/fetch.ts",
      "src/fetch.test.ts",
    ]);

    const evidence = buildUnverifiedClaimEvidence(
      commentCandidate(files, "backoff"),
      files,
    );

    expect(evidence).toMatchObject({
      specificity: "specific",
      enclosingFunction: { name: "fetchWithRetry" },
      testPinning: expect.arrayContaining([
        expect.objectContaining({ filePath: "src/fetch.test.ts" }),
      ]),
    });
  });

  it("records an issue reference as a tracked-work pointer", () => {
    const source = `// Retries transient failures with backoff. See #123 for the flaky endpoint.
export function load(url: string): Promise<string> {
  return fetch(url).then((response) => response.text());
}
`;
    const candidate = extractCandidates("src/load.ts", source)
      .find(({ kind }) => kind === "comment");
    expect(candidate).toBeDefined();
    if (!candidate) return;

    expect(buildUnverifiedClaimEvidence(
      candidate,
      [{ filePath: "src/load.ts", source }],
    )).toMatchObject({ trackedWork: ["#123"] });
  });

  it.each([
    ["intent without behavior", "// Keep this adapter so callers do not depend on the vendor API."],
    ["deferred work marker", "// TODO: handle retries for flaky endpoints."],
    ["constraint without behavior", "// must call init() first"],
  ])("abstains for %s", (_label, text) => {
    const source = `${text}
export function run(): string {
  return "ready";
}
`;
    const candidate = extractCandidates("src/run.ts", source)
      .find(({ kind }) => kind === "comment");
    expect(candidate).toBeDefined();
    if (!candidate) return;

    expect(buildUnverifiedClaimEvidence(
      candidate,
      [{ filePath: "src/run.ts", source }],
    )).toBeUndefined();
  });

  it("abstains for function candidates", async () => {
    const files = await project("unverified-claim-evasion-positive", ["src/parse.ts"]);
    const owner = files[0];
    expect(owner).toBeDefined();
    if (!owner) return;
    const candidate = extractCandidates(owner.filePath, owner.source)
      .find(({ kind }) => kind === "function");
    expect(candidate).toBeDefined();
    if (!candidate) return;

    expect(buildUnverifiedClaimEvidence(candidate, files)).toBeUndefined();
  });

  it("sends claim comments to evaluation and abstains intent comments", async () => {
    const rule = defaultConfig.rules[RULE];
    expect(rule).toBeDefined();
    if (!rule) return;
    const config: JevLintConfig = { rules: { [RULE]: rule } };
    const evaluator = new StubEvaluator();

    const claimedSource = `// Handles edge cases gracefully.
export function parseRow(input: string): string[] {
  return input.split(",");
}
`;
    const claimed = await analyzeFileWithFailures({
      filePath: "src/parse.ts",
      source: claimedSource,
      changedLines: [{ start: 1, end: 4 }],
      config,
      projectFiles: [{ filePath: "src/parse.ts", source: claimedSource }],
    }, evaluator);
    expect(claimed.judgments.map(({ ruleId }) => ruleId)).toEqual([RULE]);
    expect(claimed.abstentions).toEqual([]);

    const intentSource = `// Keep this adapter so callers do not depend on the vendor API.
export function run(): string {
  return "ready";
}
`;
    const intent = await analyzeFileWithFailures({
      filePath: "src/run.ts",
      source: intentSource,
      changedLines: [{ start: 1, end: 4 }],
      config,
      projectFiles: [{ filePath: "src/run.ts", source: intentSource }],
    }, evaluator);
    expect(intent.judgments).toEqual([]);
    expect(intent.abstentions).toEqual([
      { ruleId: RULE, candidateKind: "comment", count: 1 },
    ]);
  });
});
