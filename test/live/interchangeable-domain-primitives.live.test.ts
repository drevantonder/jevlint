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
  const rule = defaultConfig.rules["jev/no-interchangeable-domain-primitives"];
  expect(changed).toBeDefined();
  expect(rule).toBeDefined();
  if (!changed || !rule) return [];
  const config: JevLintConfig = {
    rules: { "jev/no-interchangeable-domain-primitives": rule },
  };
  return analyzeFile({
    filePath: changed.filePath,
    source: changed.source,
    changedLines: [{ start: 1, end: changed.source.split("\n").length }],
    config,
    projectFiles,
  }, evaluator);
}

liveDescribe("interchangeable domain primitives calibration", () => {
  it("separates confusable identities from ordinary values, protocol strings, and weak evidence", async () => {
    const [positive, negative, exception, ambiguous] = await Promise.all([
      project("domain-primitives-positive", [
        "src/domain/transfer-funds.ts",
        "src/application/execute-transfer.ts",
      ]),
      project("domain-primitives-negative", [
        "src/presentation/format-display-name.ts",
        "src/presentation/customer-label.ts",
      ]),
      project("domain-primitives-exception", [
        "src/http/verify-webhook.ts",
        "src/http/payment-webhook.ts",
      ]),
      project("domain-primitives-ambiguous", [
        "src/events/assign-seat.ts",
        "src/events/registration.ts",
      ]),
    ]);

    const [positiveJudgments, negativeJudgments, exceptionJudgments, ambiguousJudgments]
      = await Promise.all([
        lint(positive, "src/domain/transfer-funds.ts"),
        lint(negative, "src/presentation/format-display-name.ts"),
        lint(exception, "src/http/verify-webhook.ts"),
        lint(ambiguous, "src/events/assign-seat.ts"),
      ]);

    expect(evaluator.probabilities.get("src/domain/transfer-funds.ts"))
      .toBeGreaterThanOrEqual(0.85);
    expect(evaluator.probabilities.get("src/presentation/format-display-name.ts"))
      .toBeLessThan(0.5);
    expect(evaluator.probabilities.get("src/http/verify-webhook.ts")).toBeLessThan(0.5);
    expect(evaluator.probabilities.get("src/events/assign-seat.ts")).toBeLessThan(0.8);
    expect(positiveJudgments).toHaveLength(1);
    expect(negativeJudgments.every(({ probability }) => probability < 0.5)).toBe(true);
    expect(exceptionJudgments.every(({ probability }) => probability < 0.5)).toBe(true);
    expect(ambiguousJudgments.every(({ probability }) => probability < 0.8)).toBe(true);
  });
});
