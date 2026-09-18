import { describe, expect, it } from "vitest";
import { analyzeFile } from "../../src/analyze.js";
import { defaultConfig } from "../../src/config.js";
import { TypeSafeEvaluator } from "../../src/typesafe-evaluator.js";
import type { JevLintConfig, ProjectFile } from "../../src/types.js";

const liveDescribe = process.env.RUN_LIVE_JEV === "1" ? describe : describe.skip;
const evaluator = new TypeSafeEvaluator({ apiKey: process.env.JEVLINT_TYPESAFE_API_KEY ?? "" });

const wiredSource = `import { PostgresStore } from "./store.js";

export function processOrder(order: Order): void {
  const store = new PostgresStore(connectionString);
  store.save(order);
}
`;

const factorySource = `import { PostgresStore } from "./store.js";

export function createStore(): PostgresStore {
  return new PostgresStore(connectionString);
}
`;

async function lint(source: string, projectFiles: ProjectFile[]) {
  const rule = defaultConfig.rules["jev/no-construction-in-use"];
  expect(rule).toBeDefined();
  if (!rule) return [];
  const config: JevLintConfig = { rules: { "jev/no-construction-in-use": rule } };
  return analyzeFile({
    filePath: "src/order.ts",
    source,
    changedLines: [{ start: 1, end: source.split("\n").length }],
    config,
    projectFiles,
  }, evaluator);
}

liveDescribe("construction in use with structural evidence", () => {
  it("judges inline wiring but abstains for a factory", async () => {
    const smelly: ProjectFile[] = [{ filePath: "src/order.ts", source: wiredSource }];
    const clean: ProjectFile[] = [{ filePath: "src/order.ts", source: factorySource }];

    const [smellyJudgments, cleanJudgments] = await Promise.all([
      lint(wiredSource, smelly),
      lint(factorySource, clean),
    ]);

    expect(smellyJudgments).toHaveLength(1);
    expect(smellyJudgments[0]?.probability).toBeGreaterThanOrEqual(0);
    expect(smellyJudgments[0]?.probability).toBeLessThanOrEqual(1);
    expect(cleanJudgments).toHaveLength(0);
  });
});
