import { readFile } from "node:fs/promises";
import { describe, expect, it } from "vitest";
import { analyzeModules } from "../../src/analyze.js";
import { defaultConfig } from "../../src/config.js";
import { TypeSafeEvaluator } from "../../src/typesafe-evaluator.js";
import type { EvaluationRequest, Evaluator, JevLintConfig, ProjectFile, SourceFile } from "../../src/types.js";

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

async function project(name: string, paths: string[]): Promise<ProjectFile[]> {
  return Promise.all(paths.map(async (filePath) => ({
    filePath,
    source: await readFile(new URL(`${name}/${filePath}`, repositories), "utf8"),
  })));
}

function added(filePath: string, source: string): SourceFile {
  return {
    filePath,
    source,
    oldSource: null,
    changedLines: [{ start: 1, end: source.split("\n").length }],
  };
}

async function calibrate(name: string, paths: string[]) {
  const files = await project(name, paths);
  const changed = files.find((file) => !file.filePath.endsWith("consumer.ts"));
  const rule = defaultConfig.rules["jev/no-import-time-side-effect"];
  expect(changed).toBeDefined();
  expect(rule).toBeDefined();
  if (!changed || !rule) return { judgments: [], probability: undefined };
  const config: JevLintConfig = { rules: { "jev/no-import-time-side-effect": rule } };
  const evaluator = new RecordingEvaluator();
  const judgments = await analyzeModules({
    changes: [added(changed.filePath, changed.source)],
    config,
    projectFiles: files,
  }, evaluator);
  return { judgments, probability: evaluator.probability };
}

liveDescribe("import time side effect calibration", () => {
  it("separates import-time work from deferred configuration", async () => {
    const positive = await calibrate("import-time-side-effect-positive", [
      "src/server.ts",
      "src/metrics.ts",
      "src/consumer.ts",
    ]);
    const negative = await calibrate("import-time-side-effect-negative", ["src/config.ts"]);

    expect(positive.judgments.map(({ ruleId }) => ruleId))
      .toEqual(["jev/no-import-time-side-effect"]);
    expect(positive.probability).toBeGreaterThanOrEqual(0);
    expect(positive.probability).toBeLessThanOrEqual(1);
    expect(negative.probability).toBeUndefined();
    expect(negative.judgments).toEqual([]);
  });
});
