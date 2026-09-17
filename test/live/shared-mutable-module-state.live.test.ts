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
  const rule = defaultConfig.rules["jev/no-shared-mutable-module-state"];
  expect(changed).toBeDefined();
  expect(rule).toBeDefined();
  if (!changed || !rule) return { judgments: [], probability: undefined };
  const config: JevLintConfig = { rules: { "jev/no-shared-mutable-module-state": rule } };
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

liveDescribe("shared mutable module state calibration", () => {
  it("separates cross-export coupling from load-time configuration", async () => {
    const positive = await calibrate("shared-mutable-positive", [
      "src/batch.ts",
      "src/consumer.ts",
    ]);
    const negative = await calibrate("shared-mutable-negative", ["src/config.ts"]);
    const ambiguous = await calibrate("shared-mutable-ambiguous", ["src/pool.ts"]);

    expect(positive.probability).toBeGreaterThanOrEqual(0.85);
    expect(positive.judgments.map(({ ruleId }) => ruleId))
      .toEqual(["jev/no-shared-mutable-module-state"]);
    expect(negative.probability).toBeUndefined();
    expect(negative.judgments).toEqual([]);
    expect(ambiguous.probability).toBeLessThan(0.85);
    expect(ambiguous.judgments.every(({ probability }) => probability < 0.85)).toBe(true);
  });
});
