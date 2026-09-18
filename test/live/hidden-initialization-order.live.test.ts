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

async function lint(projectFiles: ProjectFile[], functionName: string, evaluator: Evaluator) {
  const changed = projectFiles[0];
  const rule = defaultConfig.rules["jev/no-hidden-initialization-order"];
  expect(changed).toBeDefined();
  expect(rule).toBeDefined();
  if (!changed || !rule) return [];
  const config: JevLintConfig = { rules: { "jev/no-hidden-initialization-order": rule } };
  const lines = changed.source.split("\n");
  const changedLine = lines.findIndex((line) => line.includes(`function ${functionName}`)) + 1;
  return analyzeFile({
    filePath: changed.filePath,
    source: changed.source,
    changedLines: [{ start: changedLine, end: lines.length }],
    config,
    projectFiles,
  }, evaluator);
}

liveDescribe("hidden initialization order calibration", () => {
  it("separates hidden setup from explicit dependencies and lifecycle contracts", async () => {
    const [positive, negative, exception, ambiguous] = await Promise.all([
      project("hidden-initialization-order-positive", ["src/payments.ts", "src/bootstrap.ts", "src/checkout.ts"]),
      project("hidden-initialization-order-negative", ["src/charge-order-explicit.ts", "src/checkout.ts"]),
      project("hidden-initialization-order-exception", ["src/server-lifecycle.ts", "src/runtime.ts"]),
      project("hidden-initialization-order-ambiguous", ["src/request-context.ts", "src/handler.ts"]),
    ]);
    const positiveEvaluator = new RecordingEvaluator();
    const negativeEvaluator = new RecordingEvaluator();
    const exceptionEvaluator = new RecordingEvaluator();
    const ambiguousEvaluator = new RecordingEvaluator();
    const [positiveJudgments, negativeJudgments, exceptionJudgments, ambiguousJudgments] =
      await Promise.all([
        lint(positive, "chargeOrder", positiveEvaluator),
        lint(negative, "chargeOrderExplicit", negativeEvaluator),
        lint(exception, "stopServer", exceptionEvaluator),
        lint(ambiguous, "currentRequestContext", ambiguousEvaluator),
      ]);

    expect(positiveEvaluator.probabilities.get("src/payments.ts")).toBeGreaterThanOrEqual(0.85);
    expect(negativeEvaluator.probabilities.has("src/charge-order-explicit.ts")).toBe(false);
    expect(exceptionEvaluator.probabilities.get("src/server-lifecycle.ts")).toBeLessThan(0.5);
    expect(ambiguousEvaluator.probabilities.get("src/request-context.ts")).toBeLessThan(0.85);
    expect(positiveJudgments.map(({ ruleId }) => ruleId)).toEqual(["jev/no-hidden-initialization-order"]);
    expect(negativeJudgments).toEqual([]);
    expect(exceptionJudgments.every(({ probability }) => probability < 0.5)).toBe(true);
    expect(ambiguousJudgments.every(({ probability }) => probability < 0.85)).toBe(true);
  });
});
