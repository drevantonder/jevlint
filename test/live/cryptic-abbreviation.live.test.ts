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

const RULE_ID = "jev/no-cryptic-abbreviation";

const SMELLY: ProjectFile = {
  filePath: "src/billing.ts",
  source: "// Computes the user account balance for display.\n"
    + "export interface AccountRecord {\n"
    + "  user: string;\n"
    + "  account: string;\n"
    + "  balance: number;\n"
    + "}\n"
    + "export function calcUsrAcctBal(usrAcct: AccountRecord): number {\n"
    + "  return usrAcct.balance;\n"
    + "}\n",
};
const CLEAN: ProjectFile = {
  filePath: "src/billing.ts",
  source: "export function calculateTotal(items: number[]): number {\n"
    + "  return items.reduce((sum, item) => sum + item, 0);\n"
    + "}\n",
};

async function lint(projectFiles: ProjectFile[], evaluator: Evaluator) {
  const changed = projectFiles.find(({ filePath }) => filePath === "src/billing.ts");
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

liveDescribe("cryptic abbreviation with structural evidence", () => {
  it("flags stacked shortenings but keeps dictionary words", async () => {
    const smellyEvaluator = new RecordingEvaluator();
    const cleanEvaluator = new RecordingEvaluator();
    const [smellyJudgments, cleanJudgments] = await Promise.all([
      lint([SMELLY], smellyEvaluator),
      lint([CLEAN], cleanEvaluator),
    ]);

    expect(smellyEvaluator.probabilities.get("src/billing.ts")).toBeGreaterThanOrEqual(0.85);
    expect(smellyJudgments.some(({ probability }) => probability >= 0.85)).toBe(true);
    expect(cleanJudgments.every(({ probability }) => probability < 0.5)).toBe(true);
  });
});
