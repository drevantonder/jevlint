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
  filePath: "src/pricing.ts",
  source: `const cache = new Map<string, number>();
export function formatTotal(items: Item[]) {
  const key = items.length.toString();
  if (cache.has(key)) {
    return cache.get(key) as number;
  }
  const total = items.length * 2;
  cache.set(key, total);
  return total;
}
`,
}];

const live: ProjectFile[] = [{
  filePath: "src/pricing-live.ts",
  source: `export function formatTotal(items: Item[]) {
  return items.length * 2;
}
`,
}];

async function lint(projectFiles: ProjectFile[], evaluator: Evaluator) {
  const changed = projectFiles[0];
  const rule = defaultConfig.rules["jev/no-unmeasured-performance-machinery"];
  expect(changed).toBeDefined();
  expect(rule).toBeDefined();
  if (!changed || !rule) return [];
  const config: JevLintConfig = { rules: { "jev/no-unmeasured-performance-machinery": rule } };
  return analyzeFile({
    filePath: changed.filePath,
    source: changed.source,
    changedLines: [{ start: 1, end: changed.source.split("\n").length }],
    config,
    projectFiles,
  }, evaluator);
}

liveDescribe("unmeasured performance machinery calibration", () => {
  it("flags a bespoke cache but keeps plain computation", async () => {
    const smellyEvaluator = new RecordingEvaluator();
    const liveEvaluator = new RecordingEvaluator();
    const [smellyJudgments, liveJudgments] = await Promise.all([
      lint(smelly, smellyEvaluator),
      lint(live, liveEvaluator),
    ]);

    expect(smellyEvaluator.probabilities.get("src/pricing.ts")).toBeGreaterThanOrEqual(0.7);
    expect(smellyJudgments.map(({ ruleId }) => ruleId)).toContain(
      "jev/no-unmeasured-performance-machinery",
    );
    expect(liveJudgments.every(({ probability }) => probability < 0.7)).toBe(true);
  });
});
