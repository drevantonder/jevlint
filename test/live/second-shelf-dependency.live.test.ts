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
  readonly delegate = new TypeSafeEvaluator({ apiKey: process.env.JEVLINT_TYPESAFE_API_KEY ?? "" });

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

async function calibrate(name: string, anchor: string, paths: string[]) {
  const files = await project(name, paths);
  const anchorFile = files.find((file) => file.filePath === anchor);
  const rule = defaultConfig.rules["jev/no-second-shelf-dependency"];
  expect(anchorFile).toBeDefined();
  expect(rule).toBeDefined();
  if (!anchorFile || !rule) return { judgments: [], probability: undefined };
  const config: JevLintConfig = { rules: { "jev/no-second-shelf-dependency": rule } };
  const evaluator = new RecordingEvaluator();
  const judgments = await analyzeChanges({
    changes: [{
      filePath: anchor,
      source: anchorFile.source,
      oldSource: "",
      changedLines: [{ start: 1, end: anchorFile.source.split("\n").length }],
    }],
    config,
    projectFiles: files,
  }, evaluator);
  return { judgments, probability: evaluator.probability };
}

liveDescribe("second shelf dependency calibration", () => {
  it("separates shelf duplication from sole-capability imports", async () => {
    const positive = await calibrate("second-shelf-positive", "src/report.ts", [
      "src/report.ts",
      "src/ledger.ts",
      "package.json",
    ]);
    const negative = await calibrate("second-shelf-negative", "src/report.ts", [
      "src/report.ts",
      "package.json",
    ]);

    expect(positive.probability).toBeGreaterThanOrEqual(0.85);
    expect(positive.judgments.map(({ ruleId }) => ruleId)).toContain("jev/no-second-shelf-dependency");
    expect(negative.probability).toBeDefined();
    expect(negative.probability ?? 1).toBeLessThan(positive.probability ?? 0);
  });
});
