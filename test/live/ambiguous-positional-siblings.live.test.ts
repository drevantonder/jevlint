import { describe, expect, it } from "vitest";
import { analyzeFile } from "../../src/analyze.js";
import { defaultConfig } from "../../src/config.js";
import { TypeSafeEvaluator } from "../../src/typesafe-evaluator.js";
import type { JevLintConfig, ProjectFile } from "../../src/types.js";

const liveDescribe = process.env.RUN_LIVE_JEV === "1" ? describe : describe.skip;
const evaluator = new TypeSafeEvaluator({ apiKey: process.env.JEVLINT_TYPESAFE_API_KEY ?? "" });

const SMELLY = `export function transfer(fromBalance: number, toBalance: number): number {
  return fromBalance - toBalance;
}
`;

const SMELLY_CALLER = `import { transfer } from "./ledger.js";

export function settle(checking: number, savings: number): number {
  return transfer(checking, savings);
}
`;

const CLEAN = `export function greet(name: string, excited: boolean): string {
  return excited ? "hi " + name : "hello " + name;
}
`;

async function lint(source: string, filePath: string, projectFiles: ProjectFile[]) {
  const rule = defaultConfig.rules["jev/no-ambiguous-positional-siblings"];
  expect(rule).toBeDefined();
  if (!rule) return [];
  const config: JevLintConfig = { rules: { "jev/no-ambiguous-positional-siblings": rule } };
  return analyzeFile({
    filePath,
    source,
    changedLines: [{ start: 1, end: source.split("\n").length }],
    config,
    projectFiles,
  }, evaluator);
}

liveDescribe("ambiguous positional siblings with structural evidence", () => {
  it("judges swappable siblings but abstains on distinct types", async () => {
    const smelly: ProjectFile[] = [
      { filePath: "src/ledger.ts", source: SMELLY },
      { filePath: "src/settle.ts", source: SMELLY_CALLER },
    ];
    const clean: ProjectFile[] = [{ filePath: "src/greet.ts", source: CLEAN }];

    const [smellyJudgments, cleanJudgments] = await Promise.all([
      lint(SMELLY, "src/ledger.ts", smelly),
      lint(CLEAN, "src/greet.ts", clean),
    ]);

    expect(smellyJudgments).toHaveLength(1);
    expect(smellyJudgments[0]?.probability).toBeGreaterThanOrEqual(0);
    expect(smellyJudgments[0]?.probability).toBeLessThanOrEqual(1);
    expect(cleanJudgments).toHaveLength(0);
  });
});
