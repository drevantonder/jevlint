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
  readonly delegate = new TypeSafeEvaluator({ apiKey: process.env.JEVLINT_TYPESAFE_API_KEY ?? "" });
  async evaluate(request: EvaluationRequest): Promise<Record<string, number>> {
    const answers = await this.delegate.evaluate(request);
    if (answers.q0 !== undefined) this.probabilities.push(answers.q0);
    return answers;
  }
}

function changedLinesFor(name: string, lineCount: number): SourceFile["changedLines"] {
  if (name === "divergent-change-smelly") {
    return [{ start: 6, end: 6 }, { start: 15, end: 15 }];
  }
  if (name === "divergent-change-cohesive") return [{ start: 3, end: 7 }, { start: 14, end: 14 }];
  return [{ start: 1, end: lineCount }];
}

async function changes(name: string, paths: string[]): Promise<{ files: SourceFile[]; project: ProjectFile[] }> {
  const files = await Promise.all(paths.map(async (filePath) => {
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
      changedLines: changedLinesFor(name, after.split("\n").length),
    };
  }));
  const extra = name === "divergent-change-smelly"
    ? ["src/profile.ts", "src/billing.ts"]
    : [];
  const project: ProjectFile[] = [
    ...files.map(({ filePath, source }) => ({ filePath, source })),
    ...await Promise.all(extra.map(async (filePath) => ({
      filePath,
      source: await readFile(new URL(`${name}/after/${filePath}`, repositories), "utf8"),
    }))),
  ];
  return { files, project };
}

async function lint(files: SourceFile[], project: ProjectFile[], evaluator: Evaluator) {
  const rule = defaultConfig.rules["jev/no-divergent-change"];
  expect(rule).toBeDefined();
  if (!rule) return [];
  const config: JevLintConfig = { rules: { "jev/no-divergent-change": rule } };
  return analyzeChanges({ changes: files, config, projectFiles: project }, evaluator);
}

liveDescribe("divergent change calibration", () => {
  it("flags colliding reasons but keeps a single feature", async () => {
    const [smelly, cohesive] = await Promise.all([
      changes("divergent-change-smelly", ["src/account.ts"]),
      changes("divergent-change-cohesive", ["src/account.ts"]),
    ]);
    const smellyEvaluator = new RecordingEvaluator();
    const cohesiveEvaluator = new RecordingEvaluator();
    const [smellyJudgments, cohesiveJudgments] = await Promise.all([
      lint(smelly.files, smelly.project, smellyEvaluator),
      lint(cohesive.files, cohesive.project, cohesiveEvaluator),
    ]);

    expect(smellyEvaluator.probabilities[0]).toBeGreaterThanOrEqual(0.7);
    expect(cohesiveEvaluator.probabilities[0]).toBeLessThan(0.5);
    expect(smellyJudgments.map(({ ruleId }) => ruleId)).toEqual(["jev/no-divergent-change"]);
    expect(cohesiveJudgments.every(({ probability }) => probability < 0.5)).toBe(true);
  });
});
