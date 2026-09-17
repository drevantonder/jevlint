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
  filePath: "src/orders.ts",
  source: `import { metrics } from "./telemetry";
export function placeOrder(order: Order) {
  metrics.increment("order.created");
  return save(order);
}
`,
}];

const live: ProjectFile[] = [{
  filePath: "src/orders-live.ts",
  source: `export function placeOrder(order: Order) {
  return save(order);
}
`,
}];

async function lint(projectFiles: ProjectFile[], evaluator: Evaluator) {
  const changed = projectFiles[0];
  const rule = defaultConfig.rules["jev/no-unconsumed-telemetry"];
  expect(changed).toBeDefined();
  expect(rule).toBeDefined();
  if (!changed || !rule) return [];
  const config: JevLintConfig = { rules: { "jev/no-unconsumed-telemetry": rule } };
  return analyzeFile({
    filePath: changed.filePath,
    source: changed.source,
    changedLines: [{ start: 1, end: changed.source.split("\n").length }],
    config,
    projectFiles,
  }, evaluator);
}

liveDescribe("unconsumed telemetry calibration", () => {
  it("flags an emission nobody consumes but keeps quiet code", async () => {
    const smellyEvaluator = new RecordingEvaluator();
    const liveEvaluator = new RecordingEvaluator();
    const [smellyJudgments, liveJudgments] = await Promise.all([
      lint(smelly, smellyEvaluator),
      lint(live, liveEvaluator),
    ]);

    expect(smellyEvaluator.probabilities.get("src/orders.ts")).toBeGreaterThanOrEqual(0.7);
    expect(smellyJudgments.map(({ ruleId }) => ruleId)).toContain("jev/no-unconsumed-telemetry");
    expect(liveJudgments.every(({ probability }) => probability < 0.7)).toBe(true);
  });
});
