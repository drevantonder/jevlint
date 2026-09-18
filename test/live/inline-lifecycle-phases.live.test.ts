import { describe, expect, it } from "vitest";
import { analyzeFile } from "../../src/analyze.js";
import { defaultConfig } from "../../src/config.js";
import { TypeSafeEvaluator } from "../../src/typesafe-evaluator.js";
import type { JevLintConfig, ProjectFile } from "../../src/types.js";

const liveDescribe = process.env.RUN_LIVE_JEV === "1" ? describe : describe.skip;
const evaluator = new TypeSafeEvaluator({ apiKey: process.env.JEVLINT_TYPESAFE_API_KEY ?? "" });

const dbSource = `export const pool = {
  query: async (text: string, values: unknown[]): Promise<unknown> => ({ text, values }),
};
`;

const smellySource = `import { pool } from "./db.js";

export async function confirmOrders(raw: string): Promise<string> {
  const rows = raw.split("\\n");
  const orders = rows.map((row) => row.split(","));
  for (const order of orders) {
    await pool.query("INSERT INTO orders VALUES ($1)", [order[0]]);
  }
  const body = orders.map((order) => "<li>" + order[0] + "</li>").join("");
  return "<ul>" + body + "</ul>";
}
`;

const cleanSource = `export function total(items: number[]): number {
  return items.reduce((sum, item) => sum + item, 0);
}
`;

async function lint(source: string, projectFiles: ProjectFile[]) {
  const rule = defaultConfig.rules["jev/no-inline-lifecycle-phases"];
  expect(rule).toBeDefined();
  if (!rule) return [];
  const config: JevLintConfig = { rules: { "jev/no-inline-lifecycle-phases": rule } };
  return analyzeFile({
    filePath: "src/orders.ts",
    source,
    changedLines: [{ start: 1, end: source.split("\n").length }],
    config,
    projectFiles,
  }, evaluator);
}

liveDescribe("inline lifecycle phases with structural evidence", () => {
  it("flags the inline parse-price-save-render body but keeps single-phase work", async () => {
    const smellyFiles: ProjectFile[] = [
      { filePath: "src/orders.ts", source: smellySource },
      { filePath: "src/db.ts", source: dbSource },
    ];
    const cleanFiles: ProjectFile[] = [{ filePath: "src/orders.ts", source: cleanSource }];
    const [smellyJudgments, cleanJudgments] = await Promise.all([
      lint(smellySource, smellyFiles),
      lint(cleanSource, cleanFiles),
    ]);

    expect(smellyJudgments.length).toBeGreaterThan(0);
    expect(smellyJudgments.every(({ probability }) => probability >= 0.5)).toBe(true);
    expect(cleanJudgments.length).toBe(0);
  });
});
