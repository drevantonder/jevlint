import { readFile } from "node:fs/promises";
import { describe, expect, it } from "vitest";
import { analyzeFileWithFailures } from "../src/analyze.js";
import { extractCandidates } from "../src/candidates.js";
import { defaultConfig } from "../src/config.js";
import { buildRuleEvidence } from "../src/evidence/index.js";
import { buildUnexplainedSuppressionEvidence } from "../src/evidence/unexplained-suppression.js";
import type {
  Candidate,
  EvaluationRequest,
  Evaluator,
  JevLintConfig,
  ProjectFile,
} from "../src/types.js";

const RULE = "jev/no-unexplained-suppression";
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

describe("unexplained suppression wiring", () => {
  it("ships as a comment judgment without thresholds", () => {
    expect(defaultConfig.rules[RULE]).toMatchObject({
      scope: "comment",
      message: expect.any(String),
    });
    expect(defaultConfig.rules[RULE]).not.toHaveProperty("threshold");
    expect(defaultConfig.rules[RULE]).not.toHaveProperty("severity");
  });

  it("passes bare suppressions through with scope and risky shapes", async () => {
    const files = await project("unexplained-suppression-positive", ["src/read.ts"]);

    const result = buildRuleEvidence(RULE, commentCandidate(files, "ts-expect-error"), files);

    expect(result).toEqual({ handled: true, evidence: expect.any(Object) });
    if (!result.handled) return;
    expect(result.evidence).toMatchObject({
      directive: "ts-expect-error",
      ruleFamily: "type-safety",
      scope: "line",
      rationaleWords: 0,
      riskSignals: expect.arrayContaining(["cast"]),
    });
  });

  it("abstains when the directive carries its reason", async () => {
    const files = await project("unexplained-suppression-explained", ["src/announce.ts"]);

    expect(buildUnexplainedSuppressionEvidence(
      commentCandidate(files, "eslint-disable-next-line"),
      files,
    )).toBeUndefined();
  });

  it("abstains for ordinary comments", () => {
    const source = `// Read the identifier from a validated payload.
export function readId(payload: { id: string }): string {
  return payload.id;
}
`;
    const candidate = extractCandidates("src/read.ts", source)
      .find(({ kind }) => kind === "comment");
    expect(candidate).toBeDefined();
    if (!candidate) return;

    expect(buildUnexplainedSuppressionEvidence(
      candidate,
      [{ filePath: "src/read.ts", source }],
    )).toBeUndefined();
  });

  it("abstains for function candidates", async () => {
    const files = await project("unexplained-suppression-positive", ["src/read.ts"]);
    const owner = files[0];
    expect(owner).toBeDefined();
    if (!owner) return;
    const candidate = extractCandidates(owner.filePath, owner.source)
      .find(({ kind }) => kind === "function");
    expect(candidate).toBeDefined();
    if (!candidate) return;

    expect(buildUnexplainedSuppressionEvidence(candidate, files)).toBeUndefined();
  });

  it("sends bare suppressions to evaluation and abstains explained ones", async () => {
    const rule = defaultConfig.rules[RULE];
    expect(rule).toBeDefined();
    if (!rule) return;
    const config: JevLintConfig = { rules: { [RULE]: rule } };
    const evaluator = new StubEvaluator();

    const bareSource = `// @ts-ignore
export function readId(payload: unknown): string {
  return (payload as { id: string }).id;
}
`;
    const bare = await analyzeFileWithFailures({
      filePath: "src/read.ts",
      source: bareSource,
      changedLines: [{ start: 1, end: 4 }],
      config,
      projectFiles: [{ filePath: "src/read.ts", source: bareSource }],
    }, evaluator);
    expect(bare.judgments.map(({ ruleId }) => ruleId)).toEqual([RULE]);
    expect(bare.abstentions).toEqual([]);

    const explainedSource = `// @ts-ignore because the vendor type omits the id field
export function readId(payload: unknown): string {
  return (payload as { id: string }).id;
}
`;
    const explained = await analyzeFileWithFailures({
      filePath: "src/read.ts",
      source: explainedSource,
      changedLines: [{ start: 1, end: 4 }],
      config,
      projectFiles: [{ filePath: "src/read.ts", source: explainedSource }],
    }, evaluator);
    expect(explained.judgments).toEqual([]);
    expect(explained.abstentions).toEqual([
      { ruleId: RULE, candidateKind: "comment", count: 1 },
    ]);
  });
});
