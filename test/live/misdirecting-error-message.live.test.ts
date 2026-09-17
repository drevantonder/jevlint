import { describe, expect, it } from "vitest";
import { analyzeFile } from "../../src/analyze.js";
import { defaultConfig } from "../../src/config.js";
import { TypeSafeEvaluator } from "../../src/typesafe-evaluator.js";
import type { JevLintConfig, ProjectFile } from "../../src/types.js";

const liveDescribe = process.env.RUN_LIVE_JEV === "1" ? describe : describe.skip;
const evaluator = new TypeSafeEvaluator();

const SMELLY = `export function loadConfig(text: string): unknown {
  const data = JSON.parse(text);
  if (!data) {
    throw new Error("network unreachable, check connection");
  }
  return data;
}
`;

const CLEAN = `export function fail(): never {
  throw new Error("operation failed");
}
`;

async function lint(source: string, projectFiles: ProjectFile[]) {
  const rule = defaultConfig.rules["jev/no-misdirecting-error-message"];
  expect(rule).toBeDefined();
  if (!rule) return [];
  const config: JevLintConfig = { rules: { "jev/no-misdirecting-error-message": rule } };
  return analyzeFile({
    filePath: "src/config.ts",
    source,
    changedLines: [{ start: 1, end: source.split("\n").length }],
    config,
    projectFiles,
  }, evaluator);
}

liveDescribe("misdirecting error message with structural evidence", () => {
  it("judges an unchecked cause but abstains on a generic message", async () => {
    const smelly: ProjectFile[] = [{ filePath: "src/config.ts", source: SMELLY }];
    const clean: ProjectFile[] = [{ filePath: "src/config.ts", source: CLEAN }];

    const [smellyJudgments, cleanJudgments] = await Promise.all([
      lint(SMELLY, smelly),
      lint(CLEAN, clean),
    ]);

    expect(smellyJudgments).toHaveLength(1);
    expect(smellyJudgments[0]?.probability).toBeGreaterThanOrEqual(0);
    expect(smellyJudgments[0]?.probability).toBeLessThanOrEqual(1);
    expect(cleanJudgments).toHaveLength(0);
  });
});
