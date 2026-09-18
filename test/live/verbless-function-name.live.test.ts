import { describe, expect, it } from "vitest";
import { analyzeFile } from "../../src/analyze.js";
import { defaultConfig } from "../../src/config.js";
import { TypeSafeEvaluator } from "../../src/typesafe-evaluator.js";
import type { JevLintConfig, ProjectFile } from "../../src/types.js";

const liveDescribe = process.env.RUN_LIVE_JEV === "1" ? describe : describe.skip;
const evaluator = new TypeSafeEvaluator({ apiKey: process.env.JEVLINT_TYPESAFE_API_KEY ?? "" });

const SMELLY = `const sessions = new Map<string, string>();

export function session(token: string): string {
  const cached = sessions.get(token);
  if (cached !== undefined) {
    return cached;
  }
  const created = "session:" + token;
  sessions.set(token, created);
  return created;
}
`;

const CLEAN = `export function getSession(token: string): string {
  return "session:" + token;
}
`;

async function lint(source: string, projectFiles: ProjectFile[]) {
  const rule = defaultConfig.rules["jev/no-verbless-function-name"];
  expect(rule).toBeDefined();
  if (!rule) return [];
  const config: JevLintConfig = { rules: { "jev/no-verbless-function-name": rule } };
  return analyzeFile({
    filePath: "src/session.ts",
    source,
    changedLines: [{ start: 1, end: source.split("\n").length }],
    config,
    projectFiles,
  }, evaluator);
}

liveDescribe("verbless function name with structural evidence", () => {
  it("judges a noun-named effectful function but abstains on a verb head", async () => {
    const smelly: ProjectFile[] = [{ filePath: "src/session.ts", source: SMELLY }];
    const clean: ProjectFile[] = [{ filePath: "src/session.ts", source: CLEAN }];

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
