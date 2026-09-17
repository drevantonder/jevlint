import { describe, expect, it } from "vitest";
import { analyzeFile } from "../../src/analyze.js";
import { defaultConfig } from "../../src/config.js";
import { TypeSafeEvaluator } from "../../src/typesafe-evaluator.js";
import type { JevLintConfig, ProjectFile } from "../../src/types.js";

const liveDescribe = process.env.RUN_LIVE_JEV === "1" ? describe : describe.skip;
const evaluator = new TypeSafeEvaluator();

const invoiceSource = `export interface Item {
  name: string;
  price: number;
}

export function formatInvoice(items: Item[]): string {
  const lines: string[] = [];
  for (const item of items) {
    lines.push(item.name + ": $" + item.price);
  }
  lines.push("TOTAL");
  return lines.join("\\n");
}
`;

const receiptSource = `import type { Item } from "./invoice.js";

export function formatReceipt(items: Item[]): string {
  const lines: string[] = [];
  for (const item of items) {
    lines.push(item.name + ": $" + item.price);
  }
  lines.push("TOTAL");
  return lines.join("\\n");
}
`;

const totalSource = `export function total(prices: number[]): number {
  let sum = 0;
  for (const price of prices) {
    sum += price;
  }
  return sum;
}
`;

async function lint(source: string, projectFiles: ProjectFile[]) {
  const rule = defaultConfig.rules["jev/no-duplicated-logic"];
  expect(rule).toBeDefined();
  if (!rule) return [];
  const config: JevLintConfig = { rules: { "jev/no-duplicated-logic": rule } };
  return analyzeFile({
    filePath: "src/invoice.ts",
    source,
    changedLines: [{ start: 1, end: source.split("\n").length }],
    config,
    projectFiles,
  }, evaluator);
}

liveDescribe("duplicated logic with structural evidence", () => {
  it("judges a reimplemented body but abstains on unique logic", async () => {
    const smelly: ProjectFile[] = [
      { filePath: "src/invoice.ts", source: invoiceSource },
      { filePath: "src/receipt.ts", source: receiptSource },
    ];
    const clean: ProjectFile[] = [{ filePath: "src/invoice.ts", source: totalSource }];

    const [smellyJudgments, cleanJudgments] = await Promise.all([
      lint(invoiceSource, smelly),
      lint(totalSource, clean),
    ]);

    expect(smellyJudgments).toHaveLength(1);
    expect(smellyJudgments[0]?.probability).toBeGreaterThanOrEqual(0);
    expect(smellyJudgments[0]?.probability).toBeLessThanOrEqual(1);
    expect(cleanJudgments).toHaveLength(0);
  });
});
