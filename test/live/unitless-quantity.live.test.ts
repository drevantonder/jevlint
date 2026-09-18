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

const RULE_ID = "jev/no-unitless-quantity";

const SMELLY: ProjectFile = {
  filePath: "src/retry.ts",
  source: "export function scheduleRetry(timeout: number, task: () => void): void {\n"
    + "  setTimeout(task, timeout);\n"
    + "}\n",
};
const CALLERS: ProjectFile = {
  filePath: "src/boot.ts",
  source: "import { scheduleRetry } from \"./retry.js\";\n"
    + "export function boot(run: () => void): void {\n"
    + "  scheduleRetry(500, run);\n"
    + "  scheduleRetry(30, run);\n"
    + "}\n",
};
const CLEAN: ProjectFile = {
  filePath: "src/retry.ts",
  source: "export function scheduleRetry(timeoutMs: number, task: () => void): void {\n"
    + "  setTimeout(task, timeoutMs);\n"
    + "}\n",
};

async function lint(projectFiles: ProjectFile[], evaluator: Evaluator) {
  const changed = projectFiles.find(({ filePath }) => filePath === "src/retry.ts");
  const rule = defaultConfig.rules[RULE_ID];
  expect(changed).toBeDefined();
  expect(rule).toBeDefined();
  if (!changed || !rule) return [];
  const config: JevLintConfig = { rules: { [RULE_ID]: rule } };
  return analyzeFile({
    filePath: changed.filePath,
    source: changed.source,
    changedLines: [{ start: 1, end: changed.source.split("\n").length }],
    config,
    projectFiles,
  }, evaluator);
}

liveDescribe("unitless quantity with structural evidence", () => {
  it("flags a unitless timeout but keeps the suffixed one", async () => {
    const smellyEvaluator = new RecordingEvaluator();
    const cleanEvaluator = new RecordingEvaluator();
    const [smellyJudgments, cleanJudgments] = await Promise.all([
      lint([SMELLY, CALLERS], smellyEvaluator),
      lint([CLEAN], cleanEvaluator),
    ]);

    expect(smellyEvaluator.probabilities.get("src/retry.ts")).toBeGreaterThanOrEqual(0.85);
    expect(smellyJudgments.some(({ probability }) => probability >= 0.85)).toBe(true);
    expect(cleanJudgments.every(({ probability }) => probability < 0.5)).toBe(true);
  });
});
