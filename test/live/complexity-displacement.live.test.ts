import { readFile } from "node:fs/promises";
import { describe, expect, it } from "vitest";
import { analyzeChanges } from "../../src/analyze.js";
import { defaultConfig } from "../../src/config.js";
import { TypeSafeEvaluator } from "../../src/typesafe-evaluator.js";
import type { EvaluationRequest, Evaluator, JevLintConfig, ProjectFile, SourceFile } from "../../src/types.js";

const liveDescribe = process.env.RUN_LIVE_JEV === "1" ? describe : describe.skip;
const repositories = new URL("../fixtures/repositories/", import.meta.url);

class RecordingEvaluator implements Evaluator {
  probabilities: number[] = [];
  readonly delegate = new TypeSafeEvaluator({ apiKey: process.env.TYPESAFE_API_KEY ?? "" });
  async evaluate(request: EvaluationRequest): Promise<Record<string, number>> {
    const answers = await this.delegate.evaluate(request);
    if (answers.q0 !== undefined) this.probabilities.push(answers.q0);
    return answers;
  }
}

async function changes(name: string, paths: string[]): Promise<SourceFile[]> {
  return Promise.all(paths.map(async (filePath) => {
    const after = await readFile(new URL(`${name}/after/${filePath}`, repositories), "utf8");
    let before: string | null = null;
    try {
      before = await readFile(new URL(`${name}/before/${filePath}`, repositories), "utf8");
    } catch {
      before = null;
    }
    return {
      filePath,
      source: after,
      oldSource: before,
      changedLines: [{ start: 1, end: after.split("\n").length }],
    };
  }));
}

async function lint(files: SourceFile[], evaluator: Evaluator) {
  const rule = defaultConfig.rules["jev/no-complexity-displacement"];
  expect(rule).toBeDefined();
  if (!rule) return [];
  const config: JevLintConfig = { rules: { "jev/no-complexity-displacement": rule } };
  const projectFiles: ProjectFile[] = files.map(({ filePath, source }) => ({ filePath, source }));
  return analyzeChanges({ changes: files, config, projectFiles }, evaluator);
}

liveDescribe("complexity displacement with before/after evidence", () => {
  it("flags complexity pushed into callers but keeps responsibility-revealing extraction", async () => {
    const [smelly, real] = await Promise.all([
      changes("complexity-displacement-smelly", ["src/register-user.ts", "src/signup.ts"]),
      changes("complexity-displacement-real", ["src/register-user.ts", "src/user.ts"]),
    ]);
    const smellyEvaluator = new RecordingEvaluator();
    const realEvaluator = new RecordingEvaluator();
    const [smellyJudgments, realJudgments] = await Promise.all([
      lint(smelly, smellyEvaluator),
      lint(real, realEvaluator),
    ]);

    expect(smellyEvaluator.probabilities[0]).toBeGreaterThanOrEqual(0.8);
    expect(realEvaluator.probabilities[0]).toBeLessThan(0.5);
    expect(smellyJudgments.map(({ ruleId }) => ruleId)).toEqual(["jev/no-complexity-displacement"]);
    expect(realJudgments.every(({ probability }) => probability < 0.5)).toBe(true);
  });
});
