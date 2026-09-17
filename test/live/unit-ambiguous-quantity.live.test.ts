import { describe, expect, it } from "vitest";
import { analyzeFile } from "../../src/analyze.js";
import { defaultConfig } from "../../src/config.js";
import { TypeSafeEvaluator } from "../../src/typesafe-evaluator.js";
import type { EvaluationRequest, Evaluator, JevLintConfig, ProjectFile } from "../../src/types.js";

const RULE = "jev/no-unit-ambiguous-quantity";
const liveDescribe = process.env.RUN_LIVE_JEV === "1" ? describe : describe.skip;

class RecordingEvaluator implements Evaluator {
  probability: number | undefined;
  readonly delegate = new TypeSafeEvaluator();

  async evaluate(request: EvaluationRequest): Promise<Record<string, number>> {
    const answers = await this.delegate.evaluate(request);
    this.probability = answers.q0;
    return answers;
  }
}

const SMELLY: ProjectFile = {
  filePath: "src/retry-smelly.ts",
  source: "export function scheduleRetry(timeout: number) {\n"
    + "  setTimeout(() => scheduleRetry(timeout), timeout);\n"
    + "}\n",
};
const CALLER: ProjectFile = {
  filePath: "src/handler.ts",
  source: "import { scheduleRetry } from \"./retry-smelly.js\";\n"
    + "export function onFailure() {\n"
    + "  scheduleRetry(5000);\n"
    + "}\n",
};
const CLEAN: ProjectFile = {
  filePath: "src/retry-clean.ts",
  source: "/** Schedule a retry after the given delay in milliseconds. */\n"
    + "export function scheduleRetry(timeoutMs: number) {\n"
    + "  setTimeout(() => scheduleRetry(timeoutMs), timeoutMs);\n"
    + "}\n",
};

async function lint(changed: ProjectFile, evaluator: Evaluator, projectFiles: ProjectFile[]) {
  const rule = defaultConfig.rules[RULE];
  expect(rule).toBeDefined();
  if (!rule) return [];
  const config: JevLintConfig = { rules: { [RULE]: rule } };
  return analyzeFile({
    filePath: changed.filePath,
    source: changed.source,
    changedLines: [{ start: 1, end: changed.source.split("\n").length }],
    config,
    projectFiles,
  }, evaluator);
}

liveDescribe("unit ambiguous quantity with structural evidence", () => {
  it("flags unitless quantities while suffixed names abstain", async () => {
    const evaluator = new RecordingEvaluator();
    const [smellyJudgments, cleanJudgments] = await Promise.all([
      lint(SMELLY, evaluator, [SMELLY, CALLER]),
      lint(CLEAN, new RecordingEvaluator(), [CLEAN]),
    ]);
    expect(smellyJudgments.map(({ ruleId }) => ruleId)).toContain(RULE);
    expect(cleanJudgments).toEqual([]);
    expect(evaluator.probability).toBeGreaterThanOrEqual(0.7);
  });
});
