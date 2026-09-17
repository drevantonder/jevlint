import { describe, expect, it } from "vitest";
import { analyzeFile } from "../../src/analyze.js";
import { defaultConfig } from "../../src/config.js";
import { TypeSafeEvaluator } from "../../src/typesafe-evaluator.js";
import type { EvaluationRequest, Evaluator, JevLintConfig, ProjectFile } from "../../src/types.js";

const liveDescribe = process.env.RUN_LIVE_JEV === "1" ? describe : describe.skip;
const ruleId = "jev/no-check-then-act-race";

const positive: ProjectFile[] = [
  {
    filePath: "src/cache.ts",
    source: `export async function getOrBuild(key: string) {
  if (!cache.has(key)) {
    const value = await build(key);
    cache.set(key, value);
  }
  return cache.get(key);
}
`,
  },
];

const negative: ProjectFile[] = [
  {
    filePath: "src/cache.ts",
    source: `export async function getOrBuild(key: string) {
  if (!cache.has(key)) {
    await lock.acquire();
    try {
      const value = await build(key);
      cache.set(key, value);
    } finally {
      lock.release();
    }
  }
  return cache.get(key);
}
`,
  },
];

class RecordingEvaluator implements Evaluator {
  probability: number | undefined;
  readonly delegate = new TypeSafeEvaluator();

  async evaluate(request: EvaluationRequest): Promise<Record<string, number>> {
    const answers = await this.delegate.evaluate(request);
    this.probability = answers.q0;
    return answers;
  }
}

async function calibrate(projectFiles: ProjectFile[]) {
  const changed = projectFiles[0];
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
    projectFiles,
  }, evaluator);
  return { judgments, probability: evaluator.probability };
}

liveDescribe("check-then-act race calibration", () => {
  it("scores the unguarded gap above the locked span", async () => {
    const [unguarded, locked] = await Promise.all([calibrate(positive), calibrate(negative)]);

    if (unguarded.probability === undefined || locked.probability === undefined) {
      throw new Error("live calibration produced no probability");
    }
    expect(unguarded.probability).toBeGreaterThan(locked.probability);
    expect(unguarded.judgments.map(({ ruleId: id }) => id)).toEqual([ruleId]);
  });
});
