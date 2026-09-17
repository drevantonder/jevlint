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

async function loadProject(name: string, paths: string[]): Promise<ProjectFile[]> {
  return Promise.all(paths.map(async (filePath) => ({
    filePath,
    source: await readFile(new URL(`${name}/${filePath}`, repositories), "utf8"),
  })));
}

async function calibrate(name: string, paths: string[]) {
  const projectFiles = await loadProject(name, paths);
  const changed = projectFiles[0];
  const rule = defaultConfig.rules["jev/no-unbounded-parallel-fanout"];
  expect(changed).toBeDefined();
  expect(rule).toBeDefined();
  if (!changed || !rule) return { judgments: [], probability: undefined };
  const config: JevLintConfig = { rules: { "jev/no-unbounded-parallel-fanout": rule } };
  const evaluator = new RecordingEvaluator();
  const judgments = await analyzeFile({
    filePath: changed.filePath,
    source: changed.source,
    changedLines: [{ start: 1, end: changed.source.split("\n").length }],
    config,
    projectFiles,
  }, evaluator);
  return { judgments, probability: evaluator.probability };
}

liveDescribe("unbounded parallel fanout calibration", () => {
  it("separates unbounded fan-out from limiter-bounded fan-out", async () => {
    const [positive, negative] = await Promise.all([
      calibrate("unbounded-parallel-fanout-positive", [
        "src/notify.ts",
        "src/mailer.ts",
      ]),
      calibrate("unbounded-parallel-fanout-negative", [
        "src/notify.ts",
        "src/mailer.ts",
      ]),
    ]);

    expect(positive.probability).toBeGreaterThanOrEqual(0.85);
    expect(negative.probability).toBeUndefined();
    expect(positive.judgments.map(({ ruleId }) => ruleId)).toEqual(["jev/no-unbounded-parallel-fanout"]);
    expect(negative.judgments.every(({ probability }) => probability < 0.5)).toBe(true);
  });
});
