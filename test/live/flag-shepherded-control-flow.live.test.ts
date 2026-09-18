import { describe, expect, it } from "vitest";
import { analyzeFile } from "../../src/analyze.js";
import { defaultConfig } from "../../src/config.js";
import { TypeSafeEvaluator } from "../../src/typesafe-evaluator.js";
import type { JevLintConfig, ProjectFile } from "../../src/types.js";

const liveDescribe = process.env.RUN_LIVE_JEV === "1" ? describe : describe.skip;
const evaluator = new TypeSafeEvaluator({ apiKey: process.env.JEVLINT_TYPESAFE_API_KEY ?? "" });

const smellySource = `export function summarizeOrders(orders: Array<{ total: number }>): string {
  let failed = false;
  let summary = "";
  for (const order of orders) {
    if (order.total < 0) {
      failed = true;
    }
    summary += order.total + ";";
  }
  if (failed) {
    return "invalid";
  }
  return summary;
}
`;

const cleanSource = `export function checkAll(items: number[]): boolean {
  let ok = true;
  for (const item of items) {
    if (item < 0) {
      ok = false;
    }
  }
  return ok;
}
`;

async function lint(source: string) {
  const rule = defaultConfig.rules["jev/no-flag-shepherded-control-flow"];
  expect(rule).toBeDefined();
  if (!rule) return [];
  const config: JevLintConfig = { rules: { "jev/no-flag-shepherded-control-flow": rule } };
  const projectFiles: ProjectFile[] = [{ filePath: "src/orders.ts", source }];
  return analyzeFile({
    filePath: "src/orders.ts",
    source,
    changedLines: [{ start: 1, end: source.split("\n").length }],
    config,
    projectFiles,
  }, evaluator);
}

liveDescribe("flag shepherded control flow with structural evidence", () => {
  it("flags the write-then-branch flag but keeps the returned flag", async () => {
    const [smellyJudgments, cleanJudgments] = await Promise.all([
      lint(smellySource),
      lint(cleanSource),
    ]);

    expect(smellyJudgments.length).toBeGreaterThan(0);
    expect(smellyJudgments.every(({ probability }) => probability >= 0.5)).toBe(true);
    expect(cleanJudgments.length).toBe(0);
  });
});
