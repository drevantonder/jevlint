import { readFile } from "node:fs/promises";
import { describe, expect, it } from "vitest";
import { analyzeFile } from "../../src/analyze.js";
import { defaultConfig } from "../../src/config.js";
import { TypeSafeEvaluator } from "../../src/typesafe-evaluator.js";
import type { EvaluationRequest, Evaluator, JevLintConfig, ProjectFile } from "../../src/types.js";

const liveDescribe = process.env.RUN_LIVE_JEV === "1" ? describe : describe.skip;
const repositories = new URL("../fixtures/repositories/", import.meta.url);
const ruleId = "jev/no-stale-binding-use";

class RecordingEvaluator implements Evaluator {
  probability: number | undefined;
  readonly delegate = new TypeSafeEvaluator({ apiKey: process.env.TYPESAFE_API_KEY ?? "" });

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

liveDescribe("stale binding use calibration", () => {
  it("separates the discarded update from the propagated one", async () => {
    const positive = await calibrate("stale-binding-use-positive", [
      "src/monitor.ts",
      "src/caller.ts",
    ]);
    const negative = await calibrate("stale-binding-use-negative", ["src/monitor.ts"]);

    expect(positive.probability).toBeGreaterThanOrEqual(0.85);
    expect(positive.judgments.map(({ ruleId: id }) => id)).toEqual([ruleId]);
    expect(negative.probability).toBeUndefined();
    expect(negative.judgments).toEqual([]);
  });
});
