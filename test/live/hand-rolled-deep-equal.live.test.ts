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
  filePath: "src/compare.ts",
  source: "import isEqual from \"fast-deep-equal\";\n"
    + "export function deepEqual(left: unknown, right: unknown): boolean {\n"
    + "  if (left === right) return true;\n"
    + "  if (typeof left !== \"object\" || typeof right !== \"object\" || left === null || right === null) return false;\n"
    + "  const leftKeys = Object.keys(left);\n"
    + "  const rightKeys = Object.keys(right);\n"
    + "  if (leftKeys.length !== rightKeys.length) return false;\n"
    + "  return leftKeys.every((key) => deepEqual((left as any)[key], (right as any)[key]));\n"
    + "}\n"
    + "export function sameSnapshot(left: unknown, right: unknown): boolean {\n"
    + "  return isEqual(left, right) && deepEqual(left, right);\n"
    + "}\n",
};
const PAIRED: ProjectFile = {
  filePath: "src/compare.ts",
  source: "export function sameId(left: User, right: User): boolean {\n"
    + "  return left.id === right.id;\n"
    + "}\n",
};

async function lint(projectFiles: ProjectFile[], evaluator: Evaluator) {
  const changed = projectFiles.find(({ filePath }) => filePath === "src/compare.ts");
  const rule = defaultConfig.rules["jev/no-hand-rolled-deep-equal"];
  expect(changed).toBeDefined();
  expect(rule).toBeDefined();
  if (!changed || !rule) return [];
  const config: JevLintConfig = { rules: { "jev/no-hand-rolled-deep-equal": rule } };
  return analyzeFile({
    filePath: changed.filePath,
    source: changed.source,
    changedLines: [{ start: 1, end: changed.source.split("\n").length }],
    config,
    projectFiles,
  }, evaluator);
}

liveDescribe("hand rolled deep equal with structural evidence", () => {
  it("flags a recursive compare beside an owned dep but keeps a shallow check", async () => {
    const smellyEvaluator = new RecordingEvaluator();
    const cleanEvaluator = new RecordingEvaluator();
    const [smellyJudgments, cleanJudgments] = await Promise.all([
      lint([SMELLY], smellyEvaluator),
      lint([PAIRED], cleanEvaluator),
    ]);

    expect(smellyEvaluator.probabilities.get("src/compare.ts")).toBeGreaterThanOrEqual(0.85);
    expect(smellyJudgments.some(({ probability }) => probability >= 0.85)).toBe(true);
    expect(cleanJudgments.every(({ probability }) => probability < 0.5)).toBe(true);
  });
});
