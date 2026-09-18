import { describe, expect, it } from "vitest";
import { analyzeFile } from "../../src/analyze.js";
import { defaultConfig } from "../../src/config.js";
import { TypeSafeEvaluator } from "../../src/typesafe-evaluator.js";
import type { JevLintConfig, ProjectFile } from "../../src/types.js";

const liveDescribe = process.env.RUN_LIVE_JEV === "1" ? describe : describe.skip;
const evaluator = new TypeSafeEvaluator({ apiKey: process.env.JEVLINT_TYPESAFE_API_KEY ?? "" });

const tableSource = `export function feeForRegion(region: string): number {
  switch (region) {
    case "north":
      return 10;
    case "south":
      return 20;
    case "east":
      return 30;
    case "west":
      return 40;
    default:
      return 0;
  }
}
`;

const behaviorSource = `export function handleRegion(region: string): void {
  if (region === "north") {
    validateNorth();
  } else if (region === "south") {
    logSouth();
  } else if (region === "east") {
    retryEast();
  } else {
    throw new Error("unknown");
  }
}
`;

async function lint(source: string, projectFiles: ProjectFile[]) {
  const rule = defaultConfig.rules["jev/no-table-shaped-conditional"];
  expect(rule).toBeDefined();
  if (!rule) return [];
  const config: JevLintConfig = { rules: { "jev/no-table-shaped-conditional": rule } };
  return analyzeFile({
    filePath: "src/fees.ts",
    source,
    changedLines: [{ start: 1, end: source.split("\n").length }],
    config,
    projectFiles,
  }, evaluator);
}

liveDescribe("table shaped conditional with structural evidence", () => {
  it("judges a data mapping but abstains on behavior arms", async () => {
    const smelly: ProjectFile[] = [{ filePath: "src/fees.ts", source: tableSource }];
    const clean: ProjectFile[] = [{ filePath: "src/fees.ts", source: behaviorSource }];

    const [smellyJudgments, cleanJudgments] = await Promise.all([
      lint(tableSource, smelly),
      lint(behaviorSource, clean),
    ]);

    expect(smellyJudgments).toHaveLength(1);
    expect(smellyJudgments[0]?.probability).toBeGreaterThanOrEqual(0);
    expect(smellyJudgments[0]?.probability).toBeLessThanOrEqual(1);
    expect(cleanJudgments).toHaveLength(0);
  });
});
