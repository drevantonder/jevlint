import { readFile } from "node:fs/promises";
import { describe, expect, it } from "vitest";
import { analyzeFile } from "../../src/analyze.js";
import { defaultConfig } from "../../src/config.js";
import { TypeSafeEvaluator } from "../../src/typesafe-evaluator.js";
import type { EvaluationRequest, Evaluator, JevLintConfig, ProjectFile } from "../../src/types.js";

const liveDescribe = process.env.RUN_LIVE_JEV === "1" ? describe : describe.skip;
const repositories = new URL("../fixtures/repositories/", import.meta.url);

class RecordingEvaluator implements Evaluator {
  readonly probabilities = new Map<string, number>();
  readonly delegate = new TypeSafeEvaluator({ apiKey: process.env.TYPESAFE_API_KEY ?? "" });
  async evaluate(request: EvaluationRequest): Promise<Record<string, number>> {
    const answers = await this.delegate.evaluate(request);
    const probability = answers.q0;
    if (probability !== undefined) this.probabilities.set(request.state.file.path, probability);
    return answers;
  }
}

const smellyEvaluator = new RecordingEvaluator();
const cohesiveEvaluator = new RecordingEvaluator();

async function project(name: string, paths: string[]): Promise<ProjectFile[]> {
  return Promise.all(paths.map(async (filePath) => ({
    filePath,
    source: await readFile(new URL(`${name}/${filePath}`, repositories), "utf8"),
  })));
}

async function lint(projectFiles: ProjectFile[], changedPath: string, evaluator: Evaluator) {
  const changed = projectFiles.find(({ filePath }) => filePath === changedPath);
  const rule = defaultConfig.rules["jev/no-divergent-sibling-interfaces"];
  expect(changed).toBeDefined();
  expect(rule).toBeDefined();
  if (!changed || !rule) return [];
  const config: JevLintConfig = { rules: { "jev/no-divergent-sibling-interfaces": rule } };
  return analyzeFile({
    filePath: changed.filePath,
    source: changed.source,
    changedLines: [{ start: 1, end: changed.source.split("\n").length }],
    config,
    projectFiles,
  }, evaluator);
}

liveDescribe("divergent sibling interfaces calibration", () => {
  it("flags renamed operations but keeps parameter-shaped differences", async () => {
    const [smelly, cohesive] = await Promise.all([
      project("divergent-sibling-interfaces-smelly", [
        "src/notifier-base.ts",
        "src/email-notifier.ts",
        "src/sms-notifier.ts",
        "src/push-notifier.ts",
        "src/notify.ts",
      ]),
      project("divergent-sibling-interfaces-cohesive", [
        "src/notifier-base.ts",
        "src/email-notifier.ts",
        "src/sms-notifier.ts",
      ]),
    ]);
    const [smellyJudgments, cohesiveJudgments] = await Promise.all([
      lint(smelly, "src/email-notifier.ts", smellyEvaluator),
      lint(cohesive, "src/email-notifier.ts", cohesiveEvaluator),
    ]);

    expect(smellyEvaluator.probabilities.get("src/email-notifier.ts")).toBeGreaterThanOrEqual(0.8);
    expect(cohesiveEvaluator.probabilities.get("src/email-notifier.ts")).toBeLessThan(0.5);
    expect(cohesiveJudgments.every(({ probability }) => probability < 0.5)).toBe(true);
    expect(smellyJudgments.map(({ ruleId }) => ruleId)).toEqual([
      "jev/no-divergent-sibling-interfaces",
    ]);
  });
});
