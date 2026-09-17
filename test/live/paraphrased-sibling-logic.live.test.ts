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

const HELPER: ProjectFile = {
  filePath: "src/names.ts",
  source: "export interface Customer {\n"
    + "  given: string;\n"
    + "  family: string;\n"
    + "  handle: string;\n"
    + "}\n"
    + "export function displayName(user: Customer): string {\n"
    + "  if (user.handle.length > 0) return user.handle;\n"
    + "  return user.given + \" \" + user.family;\n"
    + "}\n",
};
const SMELLY: ProjectFile = {
  filePath: "src/labels.ts",
  source: "import type { Customer } from \"./names.js\";\n"
    + "export function formatUserLabel(account: Customer): string {\n"
    + "  const { handle, given, family } = account;\n"
    + "  if (handle) return handle;\n"
    + "  return `${given} ${family}`;\n"
    + "}\n",
};
const PAIRED: ProjectFile = {
  filePath: "src/labels.ts",
  source: "import type { Customer } from \"./names.js\";\n"
    + "export function customerInitials(account: Customer): string {\n"
    + "  return `${account.given.slice(0, 1)}${account.family.slice(0, 1)}`;\n"
    + "}\n",
};

async function lint(projectFiles: ProjectFile[], evaluator: Evaluator) {
  const changed = projectFiles.find(({ filePath }) => filePath === "src/labels.ts");
  const rule = defaultConfig.rules["jev/no-paraphrased-sibling-logic"];
  expect(changed).toBeDefined();
  expect(rule).toBeDefined();
  if (!changed || !rule) return [];
  const config: JevLintConfig = { rules: { "jev/no-paraphrased-sibling-logic": rule } };
  return analyzeFile({
    filePath: changed.filePath,
    source: changed.source,
    changedLines: [{ start: 1, end: changed.source.split("\n").length }],
    config,
    projectFiles,
  }, evaluator);
}

liveDescribe("paraphrased sibling logic with structural evidence", () => {
  it("flags a reworded helper but keeps a distinct computation", async () => {
    const smellyEvaluator = new RecordingEvaluator();
    const cleanEvaluator = new RecordingEvaluator();
    const [smellyJudgments, cleanJudgments] = await Promise.all([
      lint([HELPER, SMELLY], smellyEvaluator),
      lint([HELPER, PAIRED], cleanEvaluator),
    ]);

    expect(smellyEvaluator.probabilities.get("src/labels.ts")).toBeGreaterThanOrEqual(0.85);
    expect(smellyJudgments.some(({ probability }) => probability >= 0.85)).toBe(true);
    expect(cleanJudgments.every(({ probability }) => probability < 0.5)).toBe(true);
  });
});
