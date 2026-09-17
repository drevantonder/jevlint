import { readFile } from "node:fs/promises";
import { describe, expect, it } from "vitest";
import { analyzeFile } from "../../src/analyze.js";
import { defaultConfig } from "../../src/config.js";
import { TypeSafeEvaluator } from "../../src/typesafe-evaluator.js";
import type { EvaluationRequest, Evaluator, JevLintConfig, ProjectFile } from "../../src/types.js";

const liveDescribe = process.env.RUN_LIVE_JEV === "1" ? describe : describe.skip;
const repositories = new URL("../fixtures/repositories/", import.meta.url);

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
  const rule = defaultConfig.rules["jev/no-mock-everything"];
  expect(changed).toBeDefined();
  expect(rule).toBeDefined();
  if (!changed || !rule) return { judgments: [], probability: undefined };
  const config: JevLintConfig = { rules: { "jev/no-mock-everything": rule } };
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

liveDescribe("mock everything calibration", () => {
  it("separates fully-mocked interaction checks from boundary-mocked behavior checks", async () => {
    const positive = await calibrate("mock-positive", [
      "test/pipeline.test.ts",
      "src/pipeline.ts",
    ]);
    const negative = await calibrate("mock-negative", [
      "test/report.test.ts",
      "src/report.ts",
      "src/network.ts",
    ]);
    const exception = await calibrate("mock-nomock", [
      "test/report.test.ts",
      "src/report.ts",
    ]);

    expect(positive.probability).toBeGreaterThanOrEqual(0.85);
    expect(positive.judgments.map(({ ruleId }) => ruleId)).toContain("jev/no-mock-everything");
    expect(negative.probability).toBeLessThan(0.85);
    expect(negative.judgments.every(({ probability }) => probability < 0.85)).toBe(true);
    expect(exception.probability).toBeUndefined();
    expect(exception.judgments).toEqual([]);
  });
});
