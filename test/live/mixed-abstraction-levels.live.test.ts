import { describe, expect, it } from "vitest";
import { analyzeFile } from "../../src/analyze.js";
import { defaultConfig } from "../../src/config.js";
import { TypeSafeEvaluator } from "../../src/typesafe-evaluator.js";
import type { JevLintConfig, ProjectFile } from "../../src/types.js";

const liveDescribe = process.env.RUN_LIVE_JEV === "1" ? describe : describe.skip;
const evaluator = new TypeSafeEvaluator();

const billingSource = `import { chargeCustomer } from "./payments.js";

export function settleInvoice(amounts: number[], customerId: string): number {
  let total = 0;
  for (let index = 0; index < amounts.length; index += 1) {
    total += amounts[index] ?? 0;
  }
  const receipt = chargeCustomer(customerId, total);
  let checksum = 0;
  for (let offset = 0; offset < receipt.length; offset += 1) {
    checksum ^= receipt.charCodeAt(offset);
  }
  return checksum;
}
`;

const paymentsSource = `export function chargeCustomer(customerId: string, total: number): string {
  return customerId + ":" + total;
}
`;

const settleSource = `import { chargeCustomer } from "./payments.js";

export function settle(total: number): string {
  return chargeCustomer("acme", total);
}
`;

async function lint(source: string, filePath: string, projectFiles: ProjectFile[]) {
  const rule = defaultConfig.rules["jev/no-mixed-abstraction-levels"];
  expect(rule).toBeDefined();
  if (!rule) return [];
  const config: JevLintConfig = { rules: { "jev/no-mixed-abstraction-levels": rule } };
  return analyzeFile({
    filePath,
    source,
    changedLines: [{ start: 1, end: source.split("\n").length }],
    config,
    projectFiles,
  }, evaluator);
}

liveDescribe("mixed abstraction levels with structural evidence", () => {
  it("judges interleaved mechanics but abstains at one level", async () => {
    const smelly: ProjectFile[] = [
      { filePath: "src/billing.ts", source: billingSource },
      { filePath: "src/payments.ts", source: paymentsSource },
    ];
    const clean: ProjectFile[] = [
      { filePath: "src/settle.ts", source: settleSource },
      { filePath: "src/payments.ts", source: paymentsSource },
    ];

    const [smellyJudgments, cleanJudgments] = await Promise.all([
      lint(billingSource, "src/billing.ts", smelly),
      lint(settleSource, "src/settle.ts", clean),
    ]);

    expect(smellyJudgments).toHaveLength(1);
    expect(smellyJudgments[0]?.probability).toBeGreaterThanOrEqual(0);
    expect(smellyJudgments[0]?.probability).toBeLessThanOrEqual(1);
    expect(cleanJudgments).toHaveLength(0);
  });
});
