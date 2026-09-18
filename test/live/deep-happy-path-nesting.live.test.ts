import { describe, expect, it } from "vitest";
import { analyzeFile } from "../../src/analyze.js";
import { defaultConfig } from "../../src/config.js";
import { TypeSafeEvaluator } from "../../src/typesafe-evaluator.js";
import type { EvaluationRequest, Evaluator, JevLintConfig, ProjectFile } from "../../src/types.js";

const liveDescribe = process.env.RUN_LIVE_JEV === "1" ? describe : describe.skip;

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

const smelly: ProjectFile[] = [{
  filePath: "src/pricing.ts",
  source: `export function price(order: Order) {
  if (order) {
    if (order.items) {
      if (order.items.length > 0) {
        return total(order);
      }
    }
  }
  return 0;
}
`,
}];

const flattened: ProjectFile[] = [{
  filePath: "src/pricing-flat.ts",
  source: `export function priceFlat(order: Order) {
  if (!order?.items?.length) return 0;
  return total(order);
}
`,
}];

async function lint(projectFiles: ProjectFile[], evaluator: Evaluator) {
  const changed = projectFiles[0];
  const rule = defaultConfig.rules["jev/no-deep-happy-path-nesting"];
  expect(changed).toBeDefined();
  expect(rule).toBeDefined();
  if (!changed || !rule) return [];
  const config: JevLintConfig = { rules: { "jev/no-deep-happy-path-nesting": rule } };
  return analyzeFile({
    filePath: changed.filePath,
    source: changed.source,
    changedLines: [{ start: 1, end: changed.source.split("\n").length }],
    config,
    projectFiles,
  }, evaluator);
}

liveDescribe("deep happy path nesting with structural evidence", () => {
  it("flags a buried nominal path but keeps a guarded one", async () => {
    const smellyEvaluator = new RecordingEvaluator();
    const flatEvaluator = new RecordingEvaluator();
    const [smellyJudgments, flatJudgments] = await Promise.all([
      lint(smelly, smellyEvaluator),
      lint(flattened, flatEvaluator),
    ]);

    expect(smellyEvaluator.probabilities.get("src/pricing.ts")).toBeGreaterThanOrEqual(0.7);
    expect(smellyJudgments.map(({ ruleId }) => ruleId)).toContain("jev/no-deep-happy-path-nesting");
    expect(flatJudgments.every(({ probability }) => probability < 0.7)).toBe(true);
  });
});
