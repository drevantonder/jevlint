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

const SMELLY: ProjectFile = {
  filePath: "src/chain.ts",
  source: "export function entry(value: string): string {\n"
    + "  return second(value);\n"
    + "}\n"
    + "function second(value: string): string {\n"
    + "  return third(value);\n"
    + "}\n"
    + "function third(value: string): string {\n"
    + "  return work(value);\n"
    + "}\n"
    + "function work(value: string): string {\n"
    + "  return value.toUpperCase();\n"
    + "}\n",
};
const CLEAN: ProjectFile = {
  filePath: "src/chain.ts",
  source: "export function entry(value: string): string {\n"
    + "  return work(value);\n"
    + "}\n"
    + "function work(value: string): string {\n"
    + "  return value.toUpperCase();\n"
    + "}\n",
};

async function lint(projectFiles: ProjectFile[], evaluator: Evaluator) {
  const changed = projectFiles.find(({ filePath }) => filePath === "src/chain.ts");
  const rule = defaultConfig.rules["jev/no-hollow-delegation-chain"];
  expect(changed).toBeDefined();
  expect(rule).toBeDefined();
  if (!changed || !rule) return [];
  const config: JevLintConfig = { rules: { "jev/no-hollow-delegation-chain": rule } };
  return analyzeFile({
    filePath: changed.filePath,
    source: changed.source,
    changedLines: [{ start: 1, end: changed.source.split("\n").length }],
    config,
    projectFiles,
  }, evaluator);
}

liveDescribe("hollow delegation chain with structural evidence", () => {
  it("flags a three-hop hollow chain but keeps a direct delegation", async () => {
    const smellyEvaluator = new RecordingEvaluator();
    const cleanEvaluator = new RecordingEvaluator();
    const [smellyJudgments, cleanJudgments] = await Promise.all([
      lint([SMELLY], smellyEvaluator),
      lint([CLEAN], cleanEvaluator),
    ]);

    expect(smellyEvaluator.probabilities.get("src/chain.ts")).toBeGreaterThanOrEqual(0.85);
    expect(smellyJudgments.some(({ probability }) => probability >= 0.85)).toBe(true);
    expect(cleanJudgments.every(({ probability }) => probability < 0.5)).toBe(true);
  });
});
