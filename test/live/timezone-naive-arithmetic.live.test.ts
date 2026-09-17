import { describe, expect, it } from "vitest";
import { z } from "zod";
import { analyzeFile } from "../../src/analyze.js";
import { defaultConfig } from "../../src/config.js";
import { TypeSafeEvaluator } from "../../src/typesafe-evaluator.js";
import type { EvaluationRequest, Evaluator, JevLintConfig, ProjectFile } from "../../src/types.js";

const RULE = "jev/no-timezone-naive-arithmetic";
const liveDescribe = process.env.RUN_LIVE_JEV === "1" ? describe : describe.skip;
const questionInstructionsSchema = z.object({ inspect: z.string() }).passthrough();
const ruleEvidenceSchema = z.object({
  function: z.object({ name: z.string() }).passthrough(),
}).passthrough();

class RecordingEvaluator implements Evaluator {
  readonly probabilities = new Map<string, number>();
  readonly delegate = new TypeSafeEvaluator();
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
  filePath: "src/schedule-smelly.ts",
  source: "export function nextReminder(date: Date): Date {\n"
    + "  return new Date(date.getTime() + 86400000);\n"
    + "}\n",
};
const CLEAN: ProjectFile = {
  filePath: "src/schedule-clean.ts",
  source: "export function elapsedMs(startedAt: number): number {\n"
    + "  return Date.now() - startedAt;\n"
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

liveDescribe("timezone naive arithmetic with structural evidence", () => {
  it("flags fixed day steps while monotonic durations abstain", async () => {
    const evaluator = new RecordingEvaluator();
    const [smellyJudgments, cleanJudgments] = await Promise.all([
      lint(SMELLY, evaluator),
      lint(CLEAN, evaluator),
    ]);
    expect(smellyJudgments.map(({ ruleId }) => ruleId)).toContain(RULE);
    expect(cleanJudgments).toEqual([]);
    expect(evaluator.probabilities.get("nextReminder")).toBeGreaterThanOrEqual(0.7);
  });
});
