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

const evaluator = new RecordingEvaluator();

async function project(name: string, paths: string[]): Promise<ProjectFile[]> {
  return Promise.all(paths.map(async (filePath) => ({
    filePath,
    source: await readFile(new URL(`${name}/${filePath}`, repositories), "utf8"),
  })));
}

async function lint(projectFiles: ProjectFile[], changedPath: string) {
  const changed = projectFiles.find(({ filePath }) => filePath === changedPath);
  const rule = defaultConfig.rules["jev/no-transport-coupled-domain"];
  expect(changed).toBeDefined();
  expect(rule).toBeDefined();
  if (!changed || !rule) return [];
  const config: JevLintConfig = { rules: { "jev/no-transport-coupled-domain": rule } };
  return analyzeFile({
    filePath: changed.filePath,
    source: changed.source,
    changedLines: [{ start: 1, end: changed.source.split("\n").length }],
    config,
    projectFiles,
  }, evaluator);
}

liveDescribe("transport-coupled domain calibration", () => {
  it("separates domain leakage from adapters, protocol obligations, and unclear ownership", async () => {
    const [positive, negative, exception, ambiguous] = await Promise.all([
      project("domain-transport-positive", [
        "src/domain/approve-refund.ts",
        "src/http/refund-route.ts",
        "src/persistence/refund-store.ts",
      ]),
      project("domain-transport-negative", [
        "src/http/approve-refund-route.ts",
        "src/http/routes.ts",
        "src/domain/approve-refund.ts",
      ]),
      project("domain-transport-exception", [
        "src/http/stripe-webhook.ts",
        "src/payments/publish-stripe-event.ts",
      ]),
      project("domain-transport-ambiguous", [
        "src/orders/submit-order.ts",
        "src/orders/order-service.ts",
        "src/http/routes.ts",
      ]),
    ]);

    const [positiveJudgments, negativeJudgments, exceptionJudgments, ambiguousJudgments]
      = await Promise.all([
        lint(positive, "src/domain/approve-refund.ts"),
        lint(negative, "src/http/approve-refund-route.ts"),
        lint(exception, "src/http/stripe-webhook.ts"),
        lint(ambiguous, "src/orders/submit-order.ts"),
      ]);

    expect(evaluator.probabilities.get("src/domain/approve-refund.ts"))
      .toBeGreaterThanOrEqual(0.85);
    expect(evaluator.probabilities.get("src/http/approve-refund-route.ts")).toBeLessThan(0.5);
    expect(evaluator.probabilities.get("src/http/stripe-webhook.ts")).toBeLessThan(0.5);
    expect(evaluator.probabilities.get("src/orders/submit-order.ts")).toBeLessThan(0.8);
    expect(positiveJudgments).toHaveLength(1);
    expect(negativeJudgments.every(({ probability }) => probability < 0.5)).toBe(true);
    expect(exceptionJudgments.every(({ probability }) => probability < 0.5)).toBe(true);
    expect(ambiguousJudgments.every(({ probability }) => probability < 0.8)).toBe(true);
  });
});
