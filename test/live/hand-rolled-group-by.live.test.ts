import { describe, expect, it } from "vitest";
import { analyzeFile } from "../../src/analyze.js";
import { defaultConfig } from "../../src/config.js";
import { TypeSafeEvaluator } from "../../src/typesafe-evaluator.js";
import type { EvaluationRequest, Evaluator, JevLintConfig, ProjectFile } from "../../src/types.js";

const liveDescribe = process.env.RUN_LIVE_JEV === "1" ? describe : describe.skip;

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

const SMELLY: ProjectFile = {
  filePath: "src/orders.ts",
  source: "export function groupByStatus(orders: Order[]): Record<string, Order[]> {\n"
    + "  const groups: Record<string, Order[]> = {};\n"
    + "  for (const order of orders) {\n"
    + "    const key = order.status;\n"
    + "    groups[key] ??= [];\n"
    + "    groups[key].push(order);\n"
    + "  }\n"
    + "  return groups;\n"
    + "}\n",
};
const PAIRED: ProjectFile = {
  filePath: "src/orders.ts",
  source: "export function recentTotals(orders: Order[]): number[] {\n"
    + "  const out: number[] = [];\n"
    + "  for (const order of orders) {\n"
    + "    out.push(order.total);\n"
    + "  }\n"
    + "  return out;\n"
    + "}\n",
};

async function lint(projectFiles: ProjectFile[], evaluator: Evaluator) {
  const changed = projectFiles.find(({ filePath }) => filePath === "src/orders.ts");
  const rule = defaultConfig.rules["jev/no-hand-rolled-group-by"];
  expect(changed).toBeDefined();
  expect(rule).toBeDefined();
  if (!changed || !rule) return [];
  const config: JevLintConfig = { rules: { "jev/no-hand-rolled-group-by": rule } };
  return analyzeFile({
    filePath: changed.filePath,
    source: changed.source,
    changedLines: [{ start: 1, end: changed.source.split("\n").length }],
    config,
    projectFiles,
  }, evaluator);
}

liveDescribe("hand rolled group by with structural evidence", () => {
  it("flags a hand-rolled grouping but keeps a plain mapping loop", async () => {
    const smellyEvaluator = new RecordingEvaluator();
    const cleanEvaluator = new RecordingEvaluator();
    const [smellyJudgments, cleanJudgments] = await Promise.all([
      lint([SMELLY], smellyEvaluator),
      lint([PAIRED], cleanEvaluator),
    ]);

    expect(smellyEvaluator.probabilities.get("src/orders.ts")).toBeGreaterThanOrEqual(0.85);
    expect(smellyJudgments.some(({ probability }) => probability >= 0.85)).toBe(true);
    expect(cleanJudgments.every(({ probability }) => probability < 0.5)).toBe(true);
  });
});
