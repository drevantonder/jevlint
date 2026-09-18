import { describe, expect, it } from "vitest";
import { analyzeFile } from "../../src/analyze.js";
import { defaultConfig } from "../../src/config.js";
import { TypeSafeEvaluator } from "../../src/typesafe-evaluator.js";
import type { EvaluationRequest, Evaluator, JevLintConfig, ProjectFile } from "../../src/types.js";

const liveDescribe = process.env.RUN_LIVE_JEV === "1" ? describe : describe.skip;

class RecordingEvaluator implements Evaluator {
  readonly probabilities = new Map<string, number>();
  readonly delegate = new TypeSafeEvaluator({ apiKey: process.env.TYPESAFE_API_KEY ?? "" });
  async evaluate(request: EvaluationRequest): Promise<Record<string, number>> {
    const answers = await this.delegate.evaluate(request);
    const probability = answers.q0;
    if (probability !== undefined) this.probabilities.set(request.state.file.path, probability);
    return answers;
  }
}

const RULE_ID = "jev/no-hand-rolled-number-format" as const;

const SMELLY: ProjectFile = {
  filePath: "src/money.ts",
  source: "export function formatGrouped(value: number): string {\n"
    + "  const fixed = value.toFixed(2);\n"
    + "  const grouped = fixed.replace(/\\B(?=(\\d{3})+(?!\\d))/g, \",\");\n"
    + "  return \"$\" + grouped;\n"
    + "}\n",
};
const PAIRED: ProjectFile = {
  filePath: "src/money.ts",
  source: "const formatter = new Intl.NumberFormat(\"en-US\", { style: \"currency\", currency: \"USD\" });\n"
    + "export function formatGrouped(value: number): string {\n"
    + "  return formatter.format(value);\n"
    + "}\n",
};

async function lint(projectFiles: ProjectFile[], evaluator: Evaluator) {
  const changed = projectFiles.find(({ filePath }) => filePath === "src/money.ts");
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

liveDescribe("hand-rolled number format with structural evidence", () => {
  it("regex grouping produces a judgment while the Intl pairing abstains", async () => {
    const smellyEvaluator = new RecordingEvaluator();
    const cleanEvaluator = new RecordingEvaluator();
    const [smellyJudgments, cleanJudgments] = await Promise.all([
      lint([SMELLY], smellyEvaluator),
      lint([PAIRED], cleanEvaluator),
    ]);

    expect(smellyJudgments.length).toBeGreaterThan(0);
    const best = (judgments: { probability: number }[]): number =>
      judgments.reduce((max, { probability }) => Math.max(max, probability), 0);
    expect(best(smellyJudgments)).toBeGreaterThan(best(cleanJudgments));
  });
});
