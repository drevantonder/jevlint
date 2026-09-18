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

const evaluator = new RecordingEvaluator();

async function project(name: string, paths: string[]): Promise<ProjectFile[]> {
  return Promise.all(paths.map(async (filePath) => ({
    filePath,
    source: await readFile(new URL(`${name}/${filePath}`, repositories), "utf8"),
  })));
}

async function lint(projectFiles: ProjectFile[], changedPath: string) {
  const changed = projectFiles.find(({ filePath }) => filePath === changedPath);
  const rule = defaultConfig.rules["jev/no-low-cohesion-class"];
  expect(changed).toBeDefined();
  expect(rule).toBeDefined();
  if (!changed || !rule) return [];
  const config: JevLintConfig = { rules: { "jev/no-low-cohesion-class": rule } };
  return analyzeFile({
    filePath: changed.filePath,
    source: changed.source,
    changedLines: [{ start: 1, end: changed.source.split("\n").length }],
    config,
    projectFiles,
  }, evaluator);
}

liveDescribe("low cohesion class calibration", () => {
  it("flags disjoint clusters but keeps a coherent class", async () => {
    const [smelly, cohesive] = await Promise.all([
      project("low-cohesion-class-smelly", [
        "src/order-manager.ts",
        "src/storefront.ts",
        "src/billing.ts",
        "src/fulfilment.ts",
        "src/db.ts",
        "src/ledger.ts",
        "src/mailer.ts",
      ]),
      project("low-cohesion-class-cohesive", ["src/shopping-cart.ts"]),
    ]);
    const [smellyJudgments, cohesiveJudgments] = await Promise.all([
      lint(smelly, "src/order-manager.ts"),
      lint(cohesive, "src/shopping-cart.ts"),
    ]);

    expect(evaluator.probabilities.get("src/order-manager.ts")).toBeGreaterThanOrEqual(0.8);
    expect(evaluator.probabilities.get("src/shopping-cart.ts")).toBeLessThan(0.5);
    expect(smellyJudgments.map(({ ruleId }) => ruleId)).toEqual(["jev/no-low-cohesion-class"]);
    expect(cohesiveJudgments.every(({ probability }) => probability < 0.5)).toBe(true);
  });
});
