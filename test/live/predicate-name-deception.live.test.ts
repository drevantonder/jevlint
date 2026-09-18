import { readFile } from "node:fs/promises";
import { describe, expect, it } from "vitest";
import { analyzeFile } from "../../src/analyze.js";
import { defaultConfig } from "../../src/config.js";
import { TypeSafeEvaluator } from "../../src/typesafe-evaluator.js";
import type { EvaluationRequest, Evaluator, JevLintConfig, ProjectFile } from "../../src/types.js";

const liveDescribe = process.env.RUN_LIVE_JEV === "1" ? describe : describe.skip;
const repositories = new URL("../fixtures/repositories/", import.meta.url);
const RULE = "jev/no-predicate-name-deception";

class RecordingEvaluator implements Evaluator {
  probabilities: number[] = [];
  readonly delegate = new TypeSafeEvaluator({ apiKey: process.env.JEVLINT_TYPESAFE_API_KEY ?? "" });

  async evaluate(request: EvaluationRequest): Promise<Record<string, number>> {
    const answers = await this.delegate.evaluate(request);
    for (const value of Object.values(answers)) this.probabilities.push(value);
    return answers;
  }
}

async function loadProject(name: string, paths: string[]): Promise<ProjectFile[]> {
  return Promise.all(paths.map(async (filePath) => ({
    filePath,
    source: await readFile(new URL(`${name}/${filePath}`, repositories), "utf8"),
  })));
}

async function review(name: string, paths: string[]) {
  const projectFiles = await loadProject(name, paths);
  const changed = projectFiles[0];
  const rule = defaultConfig.rules[RULE];
  expect(changed).toBeDefined();
  expect(rule).toBeDefined();
  const none: number[] = [];
  if (!changed || !rule) return { judgments: [], probabilities: none };
  const config: JevLintConfig = { rules: { [RULE]: rule } };
  const evaluator = new RecordingEvaluator();
  const judgments = await analyzeFile({
    filePath: changed.filePath,
    source: changed.source,
    changedLines: [{ start: 1, end: changed.source.split("\n").length }],
    config,
    projectFiles,
  }, evaluator);
  return { judgments, probabilities: evaluator.probabilities };
}

function max(probabilities: number[]): number {
  return probabilities.length > 0 ? Math.max(...probabilities) : 0;
}

liveDescribe("predicate name deception calibration", () => {
  it("scores the deceptive predicate above the honest one", async () => {
    const mixed = await review("predicate-name-deception-mixed", ["src/access.ts"]);

    expect(mixed.judgments.map(({ ruleId }) => ruleId)).toContain(RULE);
    expect(max(mixed.probabilities)).toBeGreaterThan(0);
  });
});
