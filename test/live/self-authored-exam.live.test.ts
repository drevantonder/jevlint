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

function changedLinesFor(name: string, filePath: string, lineCount: number): SourceFile["changedLines"] {
  if (name === "self-exam-smelly" && filePath === "src/fee.ts") {
    return [{ start: 1, end: 1 }, { start: 7, end: 9 }];
  }
  if (name === "self-exam-anchored" && filePath === "src/fee.ts") {
    return [{ start: 8, end: 8 }];
  }
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
      changedLines: changedLinesFor(name, filePath, after.split("\n").length),
    };
  }));
  const extra = name === "self-exam-smelly"
    ? ["src/discount.ts"]
    : ["src/discount.ts", "test/fee.contract.test.ts"];
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
  const rule = defaultConfig.rules["jev/no-self-authored-exam"];
  expect(rule).toBeDefined();
  if (!rule) return [];
  const config: JevLintConfig = { rules: { "jev/no-self-authored-exam": rule } };
  return analyzeChanges({ changes: files, config, projectFiles: project }, evaluator);
}

liveDescribe("self authored exam calibration", () => {
  it("flags unanchored same-diff exams but keeps anchored changes", async () => {
    const [smelly, anchored] = await Promise.all([
      changes("self-exam-smelly", ["src/fee.ts", "test/fee.test.ts"]),
      changes("self-exam-anchored", ["src/fee.ts", "test/fee.test.ts"]),
    ]);
    const smellyEvaluator = new RecordingEvaluator();
    const anchoredEvaluator = new RecordingEvaluator();
    const [smellyJudgments, anchoredJudgments] = await Promise.all([
      lint(smelly.files, smelly.project, smellyEvaluator),
      lint(anchored.files, anchored.project, anchoredEvaluator),
    ]);

    expect(smellyEvaluator.probabilities[0]).toBeGreaterThanOrEqual(0.7);
    expect(anchoredEvaluator.probabilities[0]).toBeLessThan(0.5);
    expect(smellyJudgments.map(({ ruleId }) => ruleId)).toEqual(["jev/no-self-authored-exam"]);
    expect(anchoredJudgments.every(({ probability }) => probability < 0.5)).toBe(true);
  });
});
