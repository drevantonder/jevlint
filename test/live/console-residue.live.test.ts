import { describe, expect, it } from "vitest";
import { analyzeFile } from "../../src/analyze.js";
import { defaultConfig } from "../../src/config.js";
import { TypeSafeEvaluator } from "../../src/typesafe-evaluator.js";
import type { EvaluationRequest, Evaluator, JevLintConfig, ProjectFile } from "../../src/types.js";

const liveDescribe = process.env.RUN_LIVE_JEV === "1" ? describe : describe.skip;

class RecordingEvaluator implements Evaluator {
  readonly probabilities = new Map<string, number>();
  readonly delegate = new TypeSafeEvaluator({ apiKey: process.env.JEVLINT_TYPESAFE_API_KEY ?? "" });
  async evaluate(request: EvaluationRequest): Promise<Record<string, number>> {
    const answers = await this.delegate.evaluate(request);
    const probability = answers.q0;
    if (probability !== undefined) this.probabilities.set(request.state.file.path, probability);
    return answers;
  }
}

const smelly: ProjectFile[] = [{
  filePath: "src/orders.ts",
  source: `import { logger } from "winston";
export function handleOrder(order: Order) {
  logger.info("handling order");
  console.log(order);
  return fulfill(order);
}
`,
}];

const operational: ProjectFile[] = [{
  filePath: "src/server.ts",
  source: `export function startServer(port: number) {
  try {
    return listen(port);
  } catch (error) {
    console.error("fatal startup failure", error);
    throw error;
  }
}
`,
}];

async function lint(projectFiles: ProjectFile[], evaluator: Evaluator) {
  const changed = projectFiles[0];
  const rule = defaultConfig.rules["jev/no-console-residue"];
  expect(changed).toBeDefined();
  expect(rule).toBeDefined();
  if (!changed || !rule) return [];
  const config: JevLintConfig = { rules: { "jev/no-console-residue": rule } };
  return analyzeFile({
    filePath: changed.filePath,
    source: changed.source,
    changedLines: [{ start: 1, end: changed.source.split("\n").length }],
    config,
    projectFiles,
  }, evaluator);
}

liveDescribe("console residue with structural evidence", () => {
  it("flags debug output beside a logger but keeps a fatal report", async () => {
    const smellyEvaluator = new RecordingEvaluator();
    const operationalEvaluator = new RecordingEvaluator();
    const [smellyJudgments, operationalJudgments] = await Promise.all([
      lint(smelly, smellyEvaluator),
      lint(operational, operationalEvaluator),
    ]);

    expect(smellyEvaluator.probabilities.get("src/orders.ts")).toBeGreaterThanOrEqual(0.7);
    expect(smellyJudgments.map(({ ruleId }) => ruleId)).toContain("jev/no-console-residue");
    expect(operationalJudgments.every(({ probability }) => probability < 0.7)).toBe(true);
  });
});
