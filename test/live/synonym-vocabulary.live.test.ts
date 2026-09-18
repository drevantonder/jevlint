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
  readonly delegate = new TypeSafeEvaluator({ apiKey: process.env.JEVLINT_TYPESAFE_API_KEY ?? "" });

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
  const rule = defaultConfig.rules["jev/no-synonym-vocabulary"];
  expect(changed).toBeDefined();
  expect(rule).toBeDefined();
  if (!changed || !rule) return [];
  const config: JevLintConfig = { rules: { "jev/no-synonym-vocabulary": rule } };
  return analyzeFile({
    filePath: changed.filePath,
    source: changed.source,
    changedLines: [{ start: 1, end: changed.source.split("\n").length }],
    config,
    projectFiles,
  }, evaluator);
}

liveDescribe("synonym vocabulary with repository evidence", () => {
  it("separates synonym sprawl from distinct per-entity verbs", async () => {
    const cases = await Promise.all([
      project("synonym-vocabulary-positive", ["src/users.ts"]),
      project("synonym-vocabulary-negative", ["src/store.ts"]),
    ]);
    const evaluator = new RecordingEvaluator();
    const judgments = await Promise.all(cases.map((files) => lint(files, evaluator)));

    const positive = evaluator.probabilities.get("src/users.ts");
    const negative = evaluator.probabilities.get("src/store.ts");
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
