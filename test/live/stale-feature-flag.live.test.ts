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
  filePath: "src/checkout.ts",
  source: `import { flags } from "./flags";
export function checkoutTotal(cart: Cart) {
  if (flags.newCheckout) {
    return renderNew(cart);
  }
  return renderLegacy(cart);
}
`,
}, {
  filePath: "src/flags.ts",
  source: `export const flags = { newCheckout: true };
`,
}];

const live: ProjectFile[] = [{
  filePath: "src/checkout-live.ts",
  source: `export function checkoutTotal(cart: Cart) {
  if (process.env.NEW_CHECKOUT === "1") {
    return renderNew(cart);
  }
  return renderLegacy(cart);
}
`,
}];

async function lint(projectFiles: ProjectFile[], evaluator: Evaluator) {
  const changed = projectFiles[0];
  const rule = defaultConfig.rules["jev/no-stale-feature-flag"];
  expect(changed).toBeDefined();
  expect(rule).toBeDefined();
  if (!changed || !rule) return [];
  const config: JevLintConfig = { rules: { "jev/no-stale-feature-flag": rule } };
  return analyzeFile({
    filePath: changed.filePath,
    source: changed.source,
    changedLines: [{ start: 1, end: changed.source.split("\n").length }],
    config,
    projectFiles,
  }, evaluator);
}

liveDescribe("stale feature flag with structural evidence", () => {
  it("flags a constant-bound flag but keeps a live environment flag", async () => {
    const smellyEvaluator = new RecordingEvaluator();
    const liveEvaluator = new RecordingEvaluator();
    const [smellyJudgments, liveJudgments] = await Promise.all([
      lint(smelly, smellyEvaluator),
      lint(live, liveEvaluator),
    ]);

    expect(smellyEvaluator.probabilities.get("src/checkout.ts")).toBeGreaterThanOrEqual(0.7);
    expect(smellyJudgments.map(({ ruleId }) => ruleId)).toContain("jev/no-stale-feature-flag");
    expect(liveJudgments.every(({ probability }) => probability < 0.7)).toBe(true);
  });
});
