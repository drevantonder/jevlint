import { readFile } from "node:fs/promises";
import { describe, expect, it } from "vitest";
import { analyzeFile } from "../../src/analyze.js";
import { defaultConfig } from "../../src/config.js";
import { TypeSafeEvaluator } from "../../src/typesafe-evaluator.js";
import type { EvaluationRequest, Evaluator, JevLintConfig, ProjectFile } from "../../src/types.js";

const liveDescribe = process.env.RUN_LIVE_JEV === "1" ? describe : describe.skip;
const repositories = new URL("../fixtures/repositories/", import.meta.url);
const ruleId = "jev/no-unvalidated-boundary-shape";

class RecordingEvaluator implements Evaluator {
  probability: number | undefined;
  readonly delegate = new TypeSafeEvaluator();

  async evaluate(request: EvaluationRequest): Promise<Record<string, number>> {
    const answers = await this.delegate.evaluate(request);
    this.probability = answers.q0;
    return answers;
  }
}

async function project(name: string, paths: string[]): Promise<ProjectFile[]> {
  return Promise.all(paths.map(async (filePath) => ({
    filePath,
    source: await readFile(new URL(`${name}/${filePath}`, repositories), "utf8"),
  })));
}

async function calibrate(name: string, paths: string[]) {
  const files = await project(name, paths);
  const changed = files[0];
  const rule = defaultConfig.rules[ruleId];
  expect(changed).toBeDefined();
  expect(rule).toBeDefined();
  if (!changed || !rule) return { judgments: [], probability: undefined };
  const config: JevLintConfig = { rules: { [ruleId]: rule } };
  const evaluator = new RecordingEvaluator();
  const judgments = await analyzeFile({
    filePath: changed.filePath,
    source: changed.source,
    changedLines: [{ start: 1, end: changed.source.split("\n").length }],
    config,
    projectFiles: files,
  }, evaluator);
  return { judgments, probability: evaluator.probability };
}

liveDescribe("unvalidated boundary shape calibration", () => {
  it("separates the persisted wrapper from guarded and boundary-free code", async () => {
    const positive = await calibrate("unvalidated-boundary-shape-positive", [
      "src/handler.ts",
      "src/schemas.ts",
      "src/store.ts",
      "src/caller.ts",
    ]);
    const guarded = await calibrate("unvalidated-boundary-shape-guarded", [
      "src/handler.ts",
      "src/schemas.ts",
      "src/store.ts",
    ]);
    const negative = await calibrate("unvalidated-boundary-shape-negative", ["src/handler.ts"]);

    expect(positive.probability).toBeGreaterThanOrEqual(0.85);
    expect(positive.judgments.map(({ ruleId: id }) => id)).toEqual([ruleId]);
    expect(guarded.probability).toBeLessThan(0.5);
    expect(guarded.judgments.every(({ probability }) => probability < 0.5)).toBe(true);
    expect(negative.probability).toBeUndefined();
    expect(negative.judgments).toEqual([]);
  });
});
