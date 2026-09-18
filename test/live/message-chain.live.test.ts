import { describe, expect, it } from "vitest";
import { analyzeFile } from "../../src/analyze.js";
import { defaultConfig } from "../../src/config.js";
import { TypeSafeEvaluator } from "../../src/typesafe-evaluator.js";
import type { JevLintConfig, ProjectFile } from "../../src/types.js";

const liveDescribe = process.env.RUN_LIVE_JEV === "1" ? describe : describe.skip;
const evaluator = new TypeSafeEvaluator({ apiKey: process.env.JEVLINT_TYPESAFE_API_KEY ?? "" });

const orderSource = `import { Order } from "./models.js";

export function orderZip(order: Order): string {
  return order.getCustomer().getAddress().getZip();
}
`;

const doubleSource = `export function double(value: number): number {
  return Math.max(value, 0) * 2;
}
`;

async function lint(source: string, projectFiles: ProjectFile[]) {
  const rule = defaultConfig.rules["jev/no-message-chain"];
  expect(rule).toBeDefined();
  if (!rule) return [];
  const config: JevLintConfig = { rules: { "jev/no-message-chain": rule } };
  return analyzeFile({
    filePath: "src/order.ts",
    source,
    changedLines: [{ start: 1, end: source.split("\n").length }],
    config,
    projectFiles,
  }, evaluator);
}

liveDescribe("message chain with structural evidence", () => {
  it("judges deep navigation but abstains on shallow calls", async () => {
    const smelly: ProjectFile[] = [{ filePath: "src/order.ts", source: orderSource }];
    const clean: ProjectFile[] = [{ filePath: "src/order.ts", source: doubleSource }];

    const [smellyJudgments, cleanJudgments] = await Promise.all([
      lint(orderSource, smelly),
      lint(doubleSource, clean),
    ]);

    expect(smellyJudgments).toHaveLength(1);
    expect(smellyJudgments[0]?.probability).toBeGreaterThanOrEqual(0);
    expect(smellyJudgments[0]?.probability).toBeLessThanOrEqual(1);
    expect(cleanJudgments).toHaveLength(0);
  });
});
