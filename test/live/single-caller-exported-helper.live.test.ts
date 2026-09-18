import { readFile } from "node:fs/promises";
import { describe, expect, it } from "vitest";
import { analyzeFile } from "../../src/analyze.js";
import { defaultConfig } from "../../src/config.js";
import { TypeSafeEvaluator } from "../../src/typesafe-evaluator.js";
import type { EvaluationRequest, Evaluator, JevLintConfig, ProjectFile } from "../../src/types.js";

const liveDescribe = process.env.RUN_LIVE_JEV === "1" ? describe : describe.skip;
const repositories = new URL("../fixtures/repositories/", import.meta.url);

class PassthroughEvaluator implements Evaluator {
  readonly delegate = new TypeSafeEvaluator({ apiKey: process.env.TYPESAFE_API_KEY ?? "" });
  evaluate(request: EvaluationRequest): Promise<Record<string, number>> {
    return this.delegate.evaluate(request);
  }
}
const evaluator = new PassthroughEvaluator();

async function project(name: string): Promise<ProjectFile[]> {
  return Promise.all(["src/format.ts", "src/cart.ts"].map(async (filePath) => ({
    filePath,
    source: await readFile(new URL(`${name}/${filePath}`, repositories), "utf8"),
  })));
}

async function lint(projectFiles: ProjectFile[]) {
  const changed = projectFiles[0];
  const rule = defaultConfig.rules["jev/no-single-caller-exported-helper"];
  expect(changed).toBeDefined();
  expect(rule).toBeDefined();
  if (!changed || !rule) return [];
  const config: JevLintConfig = { rules: { "jev/no-single-caller-exported-helper": rule } };
  return analyzeFile({
    filePath: changed.filePath,
    source: changed.source,
    changedLines: [{ start: 1, end: changed.source.split("\n").length }],
    config,
    projectFiles,
  }, evaluator);
}

liveDescribe("single caller exported helper with structural evidence", () => {
  it("flags the one-caller export but keeps the reused helper", async () => {
    const [smelly, shared] = await Promise.all([
      project("single-caller-smelly"),
      project("single-caller-shared"),
    ]);
    const [smellyJudgments, sharedJudgments] = await Promise.all([
      lint(smelly),
      lint(shared),
    ]);

    expect(smellyJudgments.length).toBeGreaterThan(0);
    expect(smellyJudgments.every(({ probability }) => probability >= 0.5)).toBe(true);
    expect(sharedJudgments.length).toBe(0);
  });
});
