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
  filePath: "src/cache.ts",
  source: `export function current(cache: Cache) {
  if (entry = cache.fetch()) {
    return entry;
  }
  return fallback();
}
`,
}];

const plain: ProjectFile[] = [{
  filePath: "src/ready.ts",
  source: `export function ready(enabled: boolean) {
  if (!!enabled) {
    return start();
  }
  return stop();
}
`,
}];

async function lint(projectFiles: ProjectFile[], evaluator: Evaluator) {
  const changed = projectFiles[0];
  const rule = defaultConfig.rules["jev/no-clever-expression"];
  expect(changed).toBeDefined();
  expect(rule).toBeDefined();
  if (!changed || !rule) return [];
  const config: JevLintConfig = { rules: { "jev/no-clever-expression": rule } };
  return analyzeFile({
    filePath: changed.filePath,
    source: changed.source,
    changedLines: [{ start: 1, end: changed.source.split("\n").length }],
    config,
    projectFiles,
  }, evaluator);
}

liveDescribe("clever expression with structural evidence", () => {
  it("flags assignment in a test but keeps conventional coercion", async () => {
    const smellyEvaluator = new RecordingEvaluator();
    const flatEvaluator = new RecordingEvaluator();
    const [smellyJudgments, flatJudgments] = await Promise.all([
      lint(smelly, smellyEvaluator),
      lint(plain, flatEvaluator),
    ]);

    expect(smellyEvaluator.probabilities.get("src/cache.ts")).toBeGreaterThanOrEqual(0.7);
    expect(smellyJudgments.map(({ ruleId }) => ruleId)).toContain("jev/no-clever-expression");
    expect(flatJudgments.every(({ probability }) => probability < 0.7)).toBe(true);
  });
});
