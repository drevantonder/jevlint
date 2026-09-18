import { describe, expect, it } from "vitest";
import { analyzeFile } from "../../src/analyze.js";
import { defaultConfig } from "../../src/config.js";
import { TypeSafeEvaluator } from "../../src/typesafe-evaluator.js";
import type { EvaluationRequest, Evaluator, JevLintConfig, ProjectFile } from "../../src/types.js";

const liveDescribe = process.env.RUN_LIVE_JEV === "1" ? describe : describe.skip;

class RecordingEvaluator implements Evaluator {
  readonly probabilities = new Map<string, number>();
  readonly delegate = new TypeSafeEvaluator({ apiKey: process.env.TYPESAFE_API_KEY ?? "" });
  async evaluate(request: EvaluationRequest): Promise<Record<string, number>> {
    const answers = await this.delegate.evaluate(request);
    const probability = answers.q0;
    if (probability !== undefined) this.probabilities.set(request.state.file.path, probability);
    return answers;
  }
}

const smelly: ProjectFile[] = [{
  filePath: "src/eligibility.ts",
  source: `export function eligible(user: User) {
  if (user.age >= 18 && user.verified && user.region === "eu" && !user.suspended && user.balance > 0 && user.tier !== "trial") {
    return grant(user);
  }
  return deny(user);
}
`,
}];

const simple: ProjectFile[] = [{
  filePath: "src/eligibility-simple.ts",
  source: `export function eligibleSimple(user: User) {
  if (user.verified && user.age >= 18) {
    return grant(user);
  }
  return deny(user);
}
`,
}];

async function lint(projectFiles: ProjectFile[], evaluator: Evaluator) {
  const changed = projectFiles[0];
  const rule = defaultConfig.rules["jev/no-unexplained-complex-condition"];
  expect(changed).toBeDefined();
  expect(rule).toBeDefined();
  if (!changed || !rule) return [];
  const config: JevLintConfig = { rules: { "jev/no-unexplained-complex-condition": rule } };
  return analyzeFile({
    filePath: changed.filePath,
    source: changed.source,
    changedLines: [{ start: 1, end: changed.source.split("\n").length }],
    config,
    projectFiles,
  }, evaluator);
}

liveDescribe("unexplained complex condition with structural evidence", () => {
  it("flags a dense unexplained condition but keeps a small one", async () => {
    const smellyEvaluator = new RecordingEvaluator();
    const flatEvaluator = new RecordingEvaluator();
    const [smellyJudgments, flatJudgments] = await Promise.all([
      lint(smelly, smellyEvaluator),
      lint(simple, flatEvaluator),
    ]);

    expect(smellyEvaluator.probabilities.get("src/eligibility.ts")).toBeGreaterThanOrEqual(0.7);
    expect(smellyJudgments.map(({ ruleId }) => ruleId)).toContain("jev/no-unexplained-complex-condition");
    expect(flatJudgments.every(({ probability }) => probability < 0.7)).toBe(true);
  });
});
