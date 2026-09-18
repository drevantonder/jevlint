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
  readonly delegate = new TypeSafeEvaluator({ apiKey: process.env.TYPESAFE_API_KEY ?? "" });

  async evaluate(request: EvaluationRequest): Promise<Record<string, number>> {
    const answers = await this.delegate.evaluate(request);
    this.probability = answers.q0;
    return answers;
  }
}

async function driftProject(): Promise<ProjectFile[]> {
  const paths = ["test/orders.test.ts", "test/refunds.test.ts"];
  return Promise.all(paths.map(async (filePath) => ({
    filePath,
    source: await readFile(new URL(`../fixtures/repositories/fixture-drift-positive/${filePath}`, repositories), "utf8"),
  })));
}

async function singleProject(): Promise<ProjectFile[]> {
  const filePath = "test/orders.test.ts";
  return [{
    filePath,
    source: await readFile(new URL(`../fixtures/repositories/fixture-single/${filePath}`, repositories), "utf8"),
  }];
}

async function calibrate(files: ProjectFile[]) {
  const changed = files[0];
  const rule = defaultConfig.rules["jev/no-duplicated-fixture-drift"];
  expect(changed).toBeDefined();
  expect(rule).toBeDefined();
  if (!changed || !rule) return { judgments: [], probability: undefined };
  const config: JevLintConfig = { rules: { "jev/no-duplicated-fixture-drift": rule } };
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

liveDescribe("duplicated fixture drift calibration", () => {
  it("separates drifting fixture copies from single setups", async () => {
    const positive = await calibrate(await driftProject());
    const negative = await calibrate(await singleProject());

    expect(positive.probability).toBeGreaterThanOrEqual(0.7);
    expect(positive.judgments.map(({ ruleId }) => ruleId)).toContain("jev/no-duplicated-fixture-drift");
    expect(negative.probability).toBeUndefined();
    expect(negative.judgments).toEqual([]);
  });
});
