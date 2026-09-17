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
  readonly delegate = new TypeSafeEvaluator();
  async evaluate(request: EvaluationRequest): Promise<Record<string, number>> {
    const answers = await this.delegate.evaluate(request);
    const probability = answers.q0;
    if (probability !== undefined) this.probabilities.set(request.state.file.path, probability);
    return answers;
  }
}
const evaluator = new RecordingEvaluator();

async function project(name: string, routePath: string): Promise<ProjectFile[]> {
  return [{
    filePath: routePath,
    source: await readFile(new URL(`${name}/${routePath}`, repositories), "utf8"),
  }];
}

async function lint(projectFiles: ProjectFile[]) {
  const changed = projectFiles[0];
  const rule = defaultConfig.rules["jev/no-repeated-predicate"];
  expect(changed).toBeDefined();
  expect(rule).toBeDefined();
  if (!changed || !rule) return [];
  const config: JevLintConfig = { rules: { "jev/no-repeated-predicate": rule } };
  return analyzeFile({
    filePath: changed.filePath,
    source: changed.source,
    changedLines: [{ start: 1, end: changed.source.split("\n").length }],
    config,
    projectFiles,
  }, evaluator);
}

liveDescribe("repeated predicate with structural evidence", () => {
  it("flags the unbound repetition but keeps the named outcome", async () => {
    const smelly = await project("repeated-predicate-smelly", "src/policy.ts");
    const smellyJudgments = await lint(smelly);
    expect(evaluator.probabilities.get("src/policy.ts")).toBeGreaterThanOrEqual(0.85);
    expect(smellyJudgments.map(({ span }) => span.start.line)).toEqual([3]);

    const named = await project("repeated-predicate-named", "src/policy.ts");
    const namedJudgments = await lint(named);
    expect(namedJudgments.every(({ probability }) => probability < 0.5)).toBe(true);
  });
});
