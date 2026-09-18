import { readFile } from "node:fs/promises";
import { describe, expect, it } from "vitest";
import { analyzeFile } from "../../src/analyze.js";
import { defaultConfig } from "../../src/config.js";
import { TypeSafeEvaluator } from "../../src/typesafe-evaluator.js";
import type { EvaluationRequest, Evaluator, JevLintConfig, ProjectFile } from "../../src/types.js";

const liveDescribe = process.env.RUN_LIVE_JEV === "1" ? describe : describe.skip;
const repositories = new URL("../fixtures/repositories/", import.meta.url);

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

async function project(name: string, paths: string[]): Promise<ProjectFile[]> {
  return Promise.all(paths.map(async (filePath) => ({
    filePath,
    source: await readFile(new URL(`${name}/${filePath}`, repositories), "utf8"),
  })));
}

async function lint(projectFiles: ProjectFile[], evaluator: Evaluator) {
  const changed = projectFiles[0];
  const rule = defaultConfig.rules["jev/no-parallel-enumerations"];
  expect(changed).toBeDefined();
  expect(rule).toBeDefined();
  if (!changed || !rule) return [];
  const config: JevLintConfig = { rules: { "jev/no-parallel-enumerations": rule } };
  return analyzeFile({
    filePath: changed.filePath,
    source: changed.source,
    changedLines: [{ start: 1, end: changed.source.split("\n").length }],
    config,
    projectFiles,
  }, evaluator);
}

liveDescribe("parallel enumerations with repository evidence", () => {
  it("separates manually synced literal sets from independent ones", async () => {
    const cases = await Promise.all([
      project("parallel-enumerations-positive", ["src/status.ts", "src/status-labels.ts"]),
      project("parallel-enumerations-negative", ["src/color.ts", "src/size.ts"]),
    ]);
    const evaluator = new RecordingEvaluator();
    const judgments = await Promise.all(cases.map((files) => lint(files, evaluator)));

    const positive = evaluator.probabilities.get("src/status.ts");
    const negative = evaluator.probabilities.get("src/color.ts");
    expect(positive).toBeGreaterThanOrEqual(0.85);
    expect(negative).toBeUndefined();
    const [positiveJudgments, negativeJudgments] = judgments;
    expect(positiveJudgments).toBeDefined();
    expect(negativeJudgments).toBeDefined();
    if (!positiveJudgments || !negativeJudgments) return;
    expect(positiveJudgments.some(({ probability }) => probability >= 0.85)).toBe(true);
    expect(negativeJudgments).toEqual([]);
  });
});
