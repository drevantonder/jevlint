import { readFile } from "node:fs/promises";
import { describe, expect, it } from "vitest";
import { analyzeFile } from "../../src/analyze.js";
import { defaultConfig } from "../../src/config.js";
import { TypeSafeEvaluator } from "../../src/typesafe-evaluator.js";
import type { EvaluationRequest, Evaluator, JevLintConfig, ProjectFile } from "../../src/types.js";

const liveDescribe = process.env.RUN_LIVE_JEV === "1" ? describe : describe.skip;
const repositories = new URL("../fixtures/repositories/", import.meta.url);

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

async function project(name: string, paths: string[]): Promise<ProjectFile[]> {
  return Promise.all(paths.map(async (filePath) => ({
    filePath,
    source: await readFile(new URL(`${name}/${filePath}`, repositories), "utf8"),
  })));
}

async function lint(projectFiles: ProjectFile[], evaluator: Evaluator) {
  const changed = projectFiles[0];
  const rule = defaultConfig.rules["jev/no-implicit-atomicity"];
  expect(changed).toBeDefined();
  expect(rule).toBeDefined();
  if (!changed || !rule) return [];
  const config: JevLintConfig = { rules: { "jev/no-implicit-atomicity": rule } };
  return analyzeFile({
    filePath: changed.filePath,
    source: changed.source,
    changedLines: [{ start: 1, end: changed.source.split("\n").length }],
    config,
    projectFiles,
  }, evaluator);
}

liveDescribe("implicit atomicity calibration", () => {
  it("separates an unprotected invariant from independent effects and explicit recovery", async () => {
    const evaluator = new RecordingEvaluator();
    const [positive, negative, exception, ambiguous] = await Promise.all([
      project("implicit-atomicity-positive", ["src/transfer-funds.ts", "src/api.ts"]),
      project("implicit-atomicity-negative", ["src/save-profile-and-track.ts", "src/profile-page.ts"]),
      project("implicit-atomicity-exception", ["src/transfer-funds-transactional.ts", "src/api.ts"]),
      project("implicit-atomicity-ambiguous", ["src/place-order-saga.ts", "src/checkout.ts"]),
    ]);
    const [positiveJudgments, negativeJudgments, exceptionJudgments, ambiguousJudgments] =
      await Promise.all([
        lint(positive, evaluator),
        lint(negative, evaluator),
        lint(exception, evaluator),
        lint(ambiguous, evaluator),
      ]);

    expect(evaluator.probabilities.get("src/transfer-funds.ts")).toBeGreaterThanOrEqual(0.85);
    expect(evaluator.probabilities.get("src/save-profile-and-track.ts")).toBeLessThan(0.5);
    expect(evaluator.probabilities.get("src/transfer-funds-transactional.ts")).toBeLessThan(0.5);
    expect(evaluator.probabilities.get("src/place-order-saga.ts")).toBeLessThan(0.85);
    expect(positiveJudgments.map(({ ruleId }) => ruleId)).toEqual(["jev/no-implicit-atomicity"]);
    expect(negativeJudgments.every(({ probability }) => probability < 0.5)).toBe(true);
    expect(exceptionJudgments.every(({ probability }) => probability < 0.5)).toBe(true);
    expect(ambiguousJudgments.every(({ probability }) => probability < 0.85)).toBe(true);
  });
});
