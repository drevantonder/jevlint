import { describe, expect, it } from "vitest";
import { z } from "zod";
import { analyzeFile } from "../../src/analyze.js";
import { defaultConfig } from "../../src/config.js";
import { TypeSafeEvaluator } from "../../src/typesafe-evaluator.js";
import type { EvaluationRequest, Evaluator, JevLintConfig, ProjectFile } from "../../src/types.js";

const RULE = "jev/no-floating-money-arithmetic";
const liveDescribe = process.env.RUN_LIVE_JEV === "1" ? describe : describe.skip;
const questionInstructionsSchema = z.object({ inspect: z.string() }).passthrough();
const ruleEvidenceSchema = z.object({
  function: z.object({ name: z.string() }).passthrough(),
}).passthrough();

class RecordingEvaluator implements Evaluator {
  readonly probabilities = new Map<string, number>();
  readonly delegate = new TypeSafeEvaluator({ apiKey: process.env.TYPESAFE_API_KEY ?? "" });
  async evaluate(request: EvaluationRequest): Promise<Record<string, number>> {
    const answers = await this.delegate.evaluate(request);
    for (const [questionId, probability] of Object.entries(answers)) {
      const instructions = questionInstructionsSchema.safeParse(
        request.questions[questionId]?.instructions,
      );
      if (!instructions.success) continue;
      const match = /candidates\[(\d+)]/.exec(instructions.data.inspect);
      const candidate = match?.[1] === undefined
        ? undefined
        : request.state.candidates[Number(match[1])];
      const evidence = ruleEvidenceSchema.safeParse(
        candidate?.evidence?.[RULE],
      );
      if (evidence.success) this.probabilities.set(evidence.data.function.name, probability);
    }
    return answers;
  }
}

const SMELLY: ProjectFile = {
  filePath: "src/cart-smelly.ts",
  source: "export function cartTotal(items: { price: number; qty: number }[]): number {\n"
    + "  let total = 0;\n"
    + "  for (const item of items) total += item.price * item.qty;\n"
    + "  return total;\n"
    + "}\n",
};
const CLEAN: ProjectFile = {
  filePath: "src/cart-clean.ts",
  source: "export function sumValues(values: number[]): number {\n"
    + "  let sum = 0;\n"
    + "  for (const value of values) sum += value;\n"
    + "  return sum;\n"
    + "}\n",
};

async function lint(changed: ProjectFile, evaluator: Evaluator) {
  const rule = defaultConfig.rules[RULE];
  expect(rule).toBeDefined();
  if (!rule) return [];
  const config: JevLintConfig = { rules: { [RULE]: rule } };
  return analyzeFile({
    filePath: changed.filePath,
    source: changed.source,
    changedLines: [{ start: 1, end: changed.source.split("\n").length }],
    config,
    projectFiles: [SMELLY, CLEAN],
  }, evaluator);
}

liveDescribe("floating money arithmetic with structural evidence", () => {
  it("flags float accumulation over money bindings while plain sums abstain", async () => {
    const evaluator = new RecordingEvaluator();
    const [smellyJudgments, cleanJudgments] = await Promise.all([
      lint(SMELLY, evaluator),
      lint(CLEAN, evaluator),
    ]);
    expect(smellyJudgments.map(({ ruleId }) => ruleId)).toContain(RULE);
    expect(cleanJudgments).toEqual([]);
    expect(evaluator.probabilities.get("cartTotal")).toBeGreaterThanOrEqual(0.7);
  });
});
