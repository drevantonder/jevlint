import { describe, expect, it } from "vitest";
import { analyzeFile } from "../../src/analyze.js";
import { defaultConfig } from "../../src/config.js";
import { TypeSafeEvaluator } from "../../src/typesafe-evaluator.js";
import type { EvaluationRequest, Evaluator, JevLintConfig, ProjectFile } from "../../src/types.js";

const liveDescribe = process.env.RUN_LIVE_JEV === "1" ? describe : describe.skip;
const ruleId = "jev/no-misplaced-error-boundary";

const positive: ProjectFile[] = [
  {
    filePath: "src/config.ts",
    source: `export async function loadConfig() {
  let cached: unknown;
  try {
    cached = cache.get("config");
  } catch (error) {
    cached = {};
  }
  const config = await fetchConfig();
  return { cached, config };
}
`,
  },
];

const negative: ProjectFile[] = [
  {
    filePath: "src/config.ts",
    source: `export async function loadConfig() {
  const config = await fetchConfig();
  let parsed: unknown;
  try {
    parsed = JSON.parse(config);
  } catch (error) {
    throw new Error("invalid config", { cause: error });
  }
  return parsed;
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

liveDescribe("misplaced error boundary calibration", () => {
  it("scores the misaddressed boundary above the placed one", async () => {
    const [misplaced, placed] = await Promise.all([calibrate(positive), calibrate(negative)]);

    if (misplaced.probability === undefined || placed.probability === undefined) {
      throw new Error("live calibration produced no probability");
    }
    expect(misplaced.probability).toBeGreaterThan(placed.probability);
    expect(misplaced.judgments.map(({ ruleId: id }) => id)).toEqual([ruleId]);
  });
});
