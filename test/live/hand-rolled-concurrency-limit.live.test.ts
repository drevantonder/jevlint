import { readFile } from "node:fs/promises";
import { describe, expect, it } from "vitest";
import { analyzeFile } from "../../src/analyze.js";
import { defaultConfig } from "../../src/config.js";
import { TypeSafeEvaluator } from "../../src/typesafe-evaluator.js";
import type { EvaluationRequest, Evaluator, JevLintConfig, ProjectFile } from "../../src/types.js";

const liveDescribe = process.env.RUN_LIVE_JEV === "1" ? describe : describe.skip;
const repositories = new URL("../fixtures/repositories/", import.meta.url);
const RULE = "jev/no-hand-rolled-concurrency-limit";

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

async function review(projectFiles: ProjectFile[]) {
  const changed = projectFiles.find((file) => file.filePath.includes("pool"));
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

liveDescribe("hand rolled concurrency limit calibration", () => {
  it("scores a counter-queue limiter beside p-limit above a dep-free project", async () => {
    const smelly = await review(await loadProject("hand-rolled-concurrency-limit-positive", [
      "package.json",
      "src/pool.ts",
      "src/jobs.ts",
    ]));
    const clean = await review([
      { filePath: "package.json", source: JSON.stringify({ dependencies: {} }) },
      {
        filePath: "src/pool.ts",
        source: "export async function runAll(tasks: Array<() => Promise<void>>): Promise<void> {\n"
          + "  for (const task of tasks) await task();\n"
          + "}\n",
      },
    ]);

    expect(smelly.judgments.map(({ ruleId }) => ruleId)).toContain(RULE);
    expect(clean.judgments).toEqual([]);
    expect(Math.max(...smelly.probabilities)).toBeGreaterThanOrEqual(0.5);
  });
});
