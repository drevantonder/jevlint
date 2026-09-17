import { describe, expect, it } from "vitest";
import { analyzeFile } from "../../src/analyze.js";
import { defaultConfig } from "../../src/config.js";
import { TypeSafeEvaluator } from "../../src/typesafe-evaluator.js";
import type { Evaluator, JevLintConfig, ProjectFile } from "../../src/types.js";

const liveDescribe = process.env.RUN_LIVE_JEV === "1" ? describe : describe.skip;
const RULE = "jev/no-unexplained-behavioral-literal";

class RecordingEvaluator implements Evaluator {
  readonly probabilities = new Map<string, number>();
  readonly delegate = new TypeSafeEvaluator();
  async evaluate(request: Parameters<Evaluator["evaluate"]>[0]) {
    const answers = await this.delegate.evaluate(request);
    const probability = answers.q0;
    if (probability !== undefined) this.probabilities.set(request.state.file.path, probability);
    return answers;
  }
}

const smelly: ProjectFile[] = [{
  filePath: "src/retry.ts",
  source: `export function backoff(attempt: number, timeout: number) {
  if (attempt > 7) return "exhausted";
  return timeout * 0.37;
}
`,
}];

async function lint(projectFiles: ProjectFile[], evaluator: Evaluator) {
  const changed = projectFiles[0];
  const rule = defaultConfig.rules[RULE];
  expect(changed).toBeDefined();
  expect(rule).toBeDefined();
  if (!changed || !rule) return [];
  const config: JevLintConfig = { rules: { [RULE]: rule } };
  return analyzeFile({
    filePath: changed.filePath,
    source: changed.source,
    changedLines: [{ start: 1, end: changed.source.split("\n").length }],
    config,
    projectFiles,
  }, evaluator);
}

liveDescribe("unexplained behavioral literal calibration", () => {
  it("scores bare steering literals high", async () => {
    const evaluator = new RecordingEvaluator();
    const judgments = await lint(smelly, evaluator);

    expect(judgments.map(({ ruleId }) => ruleId)).toContain(RULE);
    expect(evaluator.probabilities.get("src/retry.ts")).toBeGreaterThanOrEqual(0.7);
  });
});
