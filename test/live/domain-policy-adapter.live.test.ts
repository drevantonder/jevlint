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

const evaluator = new RecordingEvaluator();

async function project(name: string, paths: string[]): Promise<ProjectFile[]> {
  return Promise.all(paths.map(async (filePath) => ({
    filePath,
    source: await readFile(new URL(`${name}/${filePath}`, repositories), "utf8"),
  })));
}

async function lint(projectFiles: ProjectFile[], changedPath: string) {
  const changed = projectFiles.find(({ filePath }) => filePath === changedPath);
  const rule = defaultConfig.rules["jev/no-domain-policy-in-adapter"];
  expect(changed).toBeDefined();
  expect(rule).toBeDefined();
  if (!changed || !rule) return [];
  const config: JevLintConfig = { rules: { "jev/no-domain-policy-in-adapter": rule } };
  return analyzeFile({
    filePath: changed.filePath,
    source: changed.source,
    changedLines: [{ start: 1, end: changed.source.split("\n").length }],
    config,
    projectFiles,
  }, evaluator);
}

liveDescribe("domain policy in adapter calibration", () => {
  it("separates business decisions from translation, technical constraints, and unclear mapping", async () => {
    const [positive, negative, exception, ambiguous] = await Promise.all([
      project("domain-policy-adapter-positive", [
        "src/gateways/stripe-payment-gateway.ts",
        "src/application/checkout.ts",
      ]),
      project("domain-policy-adapter-negative", [
        "src/http/place-order-route.ts",
        "src/application/place-order.ts",
        "src/http/routes.ts",
      ]),
      project("domain-policy-adapter-exception", [
        "src/persistence/postgres-booking-store.ts",
        "src/domain/booking-errors.ts",
        "src/application/create-booking.ts",
      ]),
      project("domain-policy-adapter-ambiguous", [
        "src/adapters/shipping/parcel-provider.ts",
        "src/adapters/shipping/parcel-api.ts",
        "src/application/ship-order.ts",
      ]),
    ]);

    const [positiveJudgments, negativeJudgments, exceptionJudgments, ambiguousJudgments]
      = await Promise.all([
        lint(positive, "src/gateways/stripe-payment-gateway.ts"),
        lint(negative, "src/http/place-order-route.ts"),
        lint(exception, "src/persistence/postgres-booking-store.ts"),
        lint(ambiguous, "src/adapters/shipping/parcel-provider.ts"),
      ]);

    expect(evaluator.probabilities.get("src/gateways/stripe-payment-gateway.ts"))
      .toBeGreaterThanOrEqual(0.85);
    expect(evaluator.probabilities.get("src/http/place-order-route.ts")).toBeLessThan(0.5);
    expect(evaluator.probabilities.get("src/persistence/postgres-booking-store.ts"))
      .toBeLessThan(0.5);
    expect(evaluator.probabilities.get("src/adapters/shipping/parcel-provider.ts"))
      .toBeLessThan(0.8);
    expect(positiveJudgments).toHaveLength(1);
    expect(negativeJudgments.every(({ probability }) => probability < 0.5)).toBe(true);
    expect(exceptionJudgments.every(({ probability }) => probability < 0.5)).toBe(true);
    expect(ambiguousJudgments.every(({ probability }) => probability < 0.8)).toBe(true);
  });
});
