import { describe, expect, it } from "vitest";
import { analyzeFile } from "../../src/analyze.js";
import { defaultConfig } from "../../src/config.js";
import { TypeSafeEvaluator } from "../../src/typesafe-evaluator.js";
import type { JevLintConfig, ProjectFile } from "../../src/types.js";

const liveDescribe = process.env.RUN_LIVE_JEV === "1" ? describe : describe.skip;
const evaluator = new TypeSafeEvaluator({ apiKey: process.env.JEVLINT_TYPESAFE_API_KEY ?? "" });

const SMELLY = `export function fetchWithRetry(url: string): string {
  let retries = 0;
  while (retries > 3) {
    retries += 1;
  }
  return url;
}
`;

const CLEAN = `const MAX_RETRIES = 3;

export function fetchWithRetry(url: string): string {
  let retries = 0;
  while (retries > MAX_RETRIES) {
    retries += 1;
  }
  return url;
}
`;

async function lint(source: string, projectFiles: ProjectFile[]) {
  const rule = defaultConfig.rules["jev/no-unexplained-domain-threshold"];
  expect(rule).toBeDefined();
  if (!rule) return [];
  const config: JevLintConfig = { rules: { "jev/no-unexplained-domain-threshold": rule } };
  return analyzeFile({
    filePath: "src/fetch.ts",
    source,
    changedLines: [{ start: 1, end: source.split("\n").length }],
    config,
    projectFiles,
  }, evaluator);
}

liveDescribe("unexplained domain threshold with structural evidence", () => {
  it("judges a bare retry cap but abstains on a named constant", async () => {
    const smelly: ProjectFile[] = [{ filePath: "src/fetch.ts", source: SMELLY }];
    const clean: ProjectFile[] = [{ filePath: "src/fetch.ts", source: CLEAN }];

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
