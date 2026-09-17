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

const SMELLY: ProjectFile = {
  filePath: "src/pricing.ts",
  source: "// TODO: fix this later\n"
    + "export function discount(total: number): number {\n"
    + "  if (total > 100) return total * 0.9;\n"
    + "  if (total > 50) return total * 0.95;\n"
    + "  return total;\n"
    + "}\n",
};
const SELF_DESCRIBING: ProjectFile = {
  filePath: "src/pricing.ts",
  source: "// TODO(ana, PROJ-123): cap bulk discounts once finance confirms tiers; interim keeps flat 5%.\n"
    + "export function discount(total: number): number {\n"
    + "  return total * 0.95;\n"
    + "}\n",
};

async function lint(projectFiles: ProjectFile[], evaluator: Evaluator) {
  const changed = projectFiles.find(({ filePath }) => filePath === "src/pricing.ts");
  const rule = defaultConfig.rules["jev/no-unaccountable-todo"];
  expect(changed).toBeDefined();
  expect(rule).toBeDefined();
  if (!changed || !rule) return [];
  const config: JevLintConfig = { rules: { "jev/no-unaccountable-todo": rule } };
  return analyzeFile({
    filePath: changed.filePath,
    source: changed.source,
    changedLines: [{ start: 1, end: changed.source.split("\n").length }],
    config,
    projectFiles,
  }, evaluator);
}

liveDescribe("unaccountable todo with comment evidence", () => {
  it("flags a bare deferral but keeps an owned, tracked one", async () => {
    const smellyEvaluator = new RecordingEvaluator();
    const cleanEvaluator = new RecordingEvaluator();
    const [smellyJudgments, cleanJudgments] = await Promise.all([
      lint([SMELLY], smellyEvaluator),
      lint([SELF_DESCRIBING], cleanEvaluator),
    ]);

    expect(smellyEvaluator.probabilities.get("src/pricing.ts")).toBeGreaterThanOrEqual(0.85);
    expect(smellyJudgments.some(({ probability }) => probability >= 0.85)).toBe(true);
    expect(cleanJudgments.every(({ probability }) => probability < 0.5)).toBe(true);
  });
});
