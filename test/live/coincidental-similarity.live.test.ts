import { describe, expect, it } from "vitest";
import { analyzeFile } from "../../src/analyze.js";
import { defaultConfig } from "../../src/config.js";
import { TypeSafeEvaluator } from "../../src/typesafe-evaluator.js";
import type { JevLintConfig, ProjectFile } from "../../src/types.js";

const liveDescribe = process.env.RUN_LIVE_JEV === "1" ? describe : describe.skip;
const evaluator = new TypeSafeEvaluator({ apiKey: process.env.JEVLINT_TYPESAFE_API_KEY ?? "" });

const invoiceSource = `export interface Item {
  price: number;
}

export function totalInvoice(items: Item[]): number {
  const subtotal = items.reduce((sum, item) => sum + item.price, 0);
  const tax = subtotal * 0.2;
  return subtotal + tax;
}
`;

const payoutSource = `export interface Staff {
  wage: number;
}

export function totalPayout(staff: Staff[]): number {
  const subtotal = staff.reduce((sum, person) => sum + person.wage, 0);
  const bonus = subtotal * 0.1;
  return subtotal + bonus;
}
`;

const greetSource = `export function greet(name: string): string {
  return "hello " + name;
}
`;

async function lint(source: string, projectFiles: ProjectFile[]) {
  const rule = defaultConfig.rules["jev/no-coincidental-similarity"];
  expect(rule).toBeDefined();
  if (!rule) return [];
  const config: JevLintConfig = { rules: { "jev/no-coincidental-similarity": rule } };
  return analyzeFile({
    filePath: "src/billing/invoice.ts",
    source,
    changedLines: [{ start: 1, end: source.split("\n").length }],
    config,
    projectFiles,
  }, evaluator);
}

liveDescribe("coincidental similarity with structural evidence", () => {
  it("judges lookalikes with divergent meaning but abstains without a lookalike", async () => {
    const smelly: ProjectFile[] = [
      { filePath: "src/billing/invoice.ts", source: invoiceSource },
      { filePath: "src/payroll/payout.ts", source: payoutSource },
    ];
    const clean: ProjectFile[] = [{ filePath: "src/greet.ts", source: greetSource }];

    const [smellyJudgments, cleanJudgments] = await Promise.all([
      lint(invoiceSource, smelly),
      lint(greetSource, clean),
    ]);

    expect(smellyJudgments).toHaveLength(1);
    expect(smellyJudgments[0]?.probability).toBeGreaterThanOrEqual(0);
    expect(smellyJudgments[0]?.probability).toBeLessThanOrEqual(1);
    expect(cleanJudgments).toHaveLength(0);
  });
});
