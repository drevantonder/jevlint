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

async function project(name: string, paths: string[]): Promise<ProjectFile[]> {
  return Promise.all(paths.map(async (filePath) => ({
    filePath,
    source: await readFile(new URL(`${name}/${filePath}`, repositories), "utf8"),
  })));
}

async function calibrate(name: string, paths: string[], changedPath: string) {
  const files = await project(name, paths);
  const changed = files.find((file) => file.filePath === changedPath);
  const rule = defaultConfig.rules["jev/no-untestable-singleton-grab"];
  expect(changed).toBeDefined();
  expect(rule).toBeDefined();
  if (!changed || !rule) return { judgments: [], probability: undefined };
  const config: JevLintConfig = { rules: { "jev/no-untestable-singleton-grab": rule } };
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

liveDescribe("untestable singleton grab calibration", () => {
  it("separates ambient grabs from wiring and injected collaborators", async () => {
    const positive = await calibrate(
      "singleton-smelly",
      ["src/pricing.ts", "src/db.ts"],
      "src/pricing.ts",
    );
    const wired = await calibrate(
      "singleton-wired",
      ["src/wiring.ts", "src/pricing.ts", "src/db.ts"],
      "src/wiring.ts",
    );
    const injected = await calibrate(
      "singleton-wired",
      ["src/wiring.ts", "src/pricing.ts", "src/db.ts"],
      "src/pricing.ts",
    );

    expect(positive.probability).toBeGreaterThanOrEqual(0.85);
    expect(positive.judgments.map(({ ruleId }) => ruleId)).toContain(
      "jev/no-untestable-singleton-grab",
    );
    expect(wired.probability).toBeLessThan(0.85);
    expect(wired.judgments.every(({ probability }) => probability < 0.85)).toBe(true);
    expect(injected.probability).toBeUndefined();
    expect(injected.judgments).toEqual([]);
  });
});
