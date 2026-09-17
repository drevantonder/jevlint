import { describe, expect, it } from "vitest";
import { analyzeFile } from "../../src/analyze.js";
import { defaultConfig } from "../../src/config.js";
import { TypeSafeEvaluator } from "../../src/typesafe-evaluator.js";
import type { EvaluationRequest, Evaluator, JevLintConfig, ProjectFile } from "../../src/types.js";

const liveDescribe = process.env.RUN_LIVE_JEV === "1" ? describe : describe.skip;

class RecordingEvaluator implements Evaluator {
  readonly probabilities = new Map<string, number>();
  readonly delegate = new TypeSafeEvaluator();
  async evaluate(request: EvaluationRequest): Promise<Record<string, number>> {
    const answers = await this.delegate.evaluate(request);
    const probability = answers.q0;
    if (probability !== undefined) this.probabilities.set(request.state.file.path, probability);
    return answers;
  }
}

const smelly: ProjectFile[] = [{
  filePath: "src/routing.ts",
  source: `export function route(mode: string) {
  return mode === "fast" ? startFast() : mode === "slow" ? startSlow() : stop();
}
`,
}];

const flat: ProjectFile[] = [{
  filePath: "src/label.ts",
  source: `export function label(ok: boolean) {
  return ok ? "yes" : "no";
}
`,
}];

async function lint(projectFiles: ProjectFile[], evaluator: Evaluator) {
  const changed = projectFiles[0];
  const rule = defaultConfig.rules["jev/no-side-effecting-conditional-expression"];
  expect(changed).toBeDefined();
  expect(rule).toBeDefined();
  if (!changed || !rule) return [];
  const config: JevLintConfig = { rules: { "jev/no-side-effecting-conditional-expression": rule } };
  return analyzeFile({
    filePath: changed.filePath,
    source: changed.source,
    changedLines: [{ start: 1, end: changed.source.split("\n").length }],
    config,
    projectFiles,
  }, evaluator);
}

liveDescribe("side effecting conditional expression with structural evidence", () => {
  it("flags a nested effectful ternary but keeps a flat pure one", async () => {
    const smellyEvaluator = new RecordingEvaluator();
    const flatEvaluator = new RecordingEvaluator();
    const [smellyJudgments, flatJudgments] = await Promise.all([
      lint(smelly, smellyEvaluator),
      lint(flat, flatEvaluator),
    ]);

    expect(smellyEvaluator.probabilities.get("src/routing.ts")).toBeGreaterThanOrEqual(0.7);
    expect(smellyJudgments.map(({ ruleId }) => ruleId)).toContain("jev/no-side-effecting-conditional-expression");
    expect(flatJudgments.every(({ probability }) => probability < 0.7)).toBe(true);
  });
});
