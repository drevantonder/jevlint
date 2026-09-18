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
  readonly delegate = new TypeSafeEvaluator({ apiKey: process.env.JEVLINT_TYPESAFE_API_KEY ?? "" });

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
  const rule = defaultConfig.rules["jev/no-unconstrained-state-string"];
  expect(changed).toBeDefined();
  expect(rule).toBeDefined();
  if (!changed || !rule) return [];
  const config: JevLintConfig = { rules: { "jev/no-unconstrained-state-string": rule } };
  return analyzeFile({
    filePath: changed.filePath,
    source: changed.source,
    changedLines: [{ start: 1, end: changed.source.split("\n").length }],
    config,
    projectFiles,
  }, evaluator);
}

liveDescribe("unconstrained state strings with repository evidence", () => {
  it("separates closed internal state from open and boundary strings", async () => {
    const cases = await Promise.all([
      project("unconstrained-state-string-positive", ["src/order-process.ts", "src/order-actions.ts"]),
      project("unconstrained-state-string-negative", ["src/localization-request.ts", "src/greeting.ts"]),
      project("unconstrained-state-string-exception", ["src/provider-event.ts", "src/handle-provider-event.ts"]),
      project("unconstrained-state-string-ambiguous", ["src/job.ts"]),
    ]);
    const evaluator = new RecordingEvaluator();
    const judgments = await Promise.all(cases.map((files) => lint(files, evaluator)));

    expect(evaluator.probabilities.get("src/order-process.ts")).toBeGreaterThanOrEqual(0.85);
    expect(evaluator.probabilities.get("src/localization-request.ts")).toBeLessThan(0.5);
    expect(evaluator.probabilities.get("src/provider-event.ts")).toBeLessThan(0.5);
    expect(evaluator.probabilities.get("src/job.ts")).toBeLessThan(0.85);
    const [positiveJudgments, negativeJudgments, exceptionJudgments, ambiguousJudgments] = judgments;
    expect(positiveJudgments).toBeDefined();
    expect(negativeJudgments).toBeDefined();
    expect(exceptionJudgments).toBeDefined();
    expect(ambiguousJudgments).toBeDefined();
    if (!positiveJudgments || !negativeJudgments || !exceptionJudgments || !ambiguousJudgments) return;
    expect(positiveJudgments.some(({ probability }) => probability >= 0.85)).toBe(true);
    expect(negativeJudgments.every(({ probability }) => probability < 0.5)).toBe(true);
    expect(exceptionJudgments.every(({ probability }) => probability < 0.5)).toBe(true);
    expect(ambiguousJudgments.every(({ probability }) => probability < 0.85)).toBe(true);
    expect(negativeJudgments.length).toBeGreaterThan(0);
    expect(exceptionJudgments.length).toBeGreaterThan(0);
    expect(ambiguousJudgments.length).toBeGreaterThan(0);
  });
});
