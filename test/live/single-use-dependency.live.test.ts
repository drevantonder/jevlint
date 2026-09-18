import { readFile } from "node:fs/promises";
import { describe, expect, it } from "vitest";
import { analyzeChanges } from "../../src/analyze.js";
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

async function calibrate(name: string, paths: string[]) {
  const files = await project(name, paths);
  const manifest = files.find((file) => file.filePath === "package.json");
  const rule = defaultConfig.rules["jev/no-single-use-dependency"];
  expect(manifest).toBeDefined();
  expect(rule).toBeDefined();
  if (!manifest || !rule) return { judgments: [], probability: undefined };
  const config: JevLintConfig = { rules: { "jev/no-single-use-dependency": rule } };
  const evaluator = new RecordingEvaluator();
  const judgments = await analyzeChanges({
    changes: [{
      filePath: "package.json",
      source: manifest.source,
      oldSource: JSON.stringify({ name, version: "1.0.0", dependencies: {} }),
      changedLines: [{ start: 1, end: 8 }],
    }],
    config,
    projectFiles: files,
  }, evaluator);
  return { judgments, probability: evaluator.probability };
}

liveDescribe("single use dependency calibration", () => {
  it("separates trivial single uses from broad adoption", async () => {
    const positive = await calibrate("single-use-positive", [
      "package.json",
      "src/id.ts",
    ]);
    const negative = await calibrate("single-use-negative", [
      "package.json",
      "src/schemas.ts",
      "src/parse.ts",
      "src/count.ts",
    ]);

    expect(positive.probability).toBeGreaterThanOrEqual(0.85);
    expect(positive.judgments.map(({ ruleId }) => ruleId)).toContain("jev/no-single-use-dependency");
    expect(negative.probability).toBeDefined();
    expect(negative.probability ?? 1).toBeLessThan(positive.probability ?? 0);
  });
});
