import { describe, expect, it } from "vitest";
import { analyzeFile } from "../../src/analyze.js";
import { defaultConfig } from "../../src/config.js";
import { TypeSafeEvaluator } from "../../src/typesafe-evaluator.js";
import type { JevLintConfig, ProjectFile } from "../../src/types.js";

const liveDescribe = process.env.RUN_LIVE_JEV === "1" ? describe : describe.skip;
const evaluator = new TypeSafeEvaluator({ apiKey: process.env.TYPESAFE_API_KEY ?? "" });

const SMELLY = `import { writeRecord } from "./store.js";

export async function saveRecord(id: string, record: unknown): Promise<void> {
  try {
    await writeRecord(id, record);
  } catch (e) {
    throw new Error(\`failed to save record: \${e.message}\`, { cause: e });
  }
}
`;

const CLEAN = `export function add(left: number, right: number): number {
  return left + right;
}
`;

async function lint(source: string, projectFiles: ProjectFile[]) {
  const rule = defaultConfig.rules["jev/no-stacked-error-boilerplate"];
  expect(rule).toBeDefined();
  if (!rule) return [];
  const config: JevLintConfig = { rules: { "jev/no-stacked-error-boilerplate": rule } };
  return analyzeFile({
    filePath: "src/save-record.ts",
    source,
    changedLines: [{ start: 1, end: source.split("\n").length }],
    config,
    projectFiles,
  }, evaluator);
}

liveDescribe("stacked error boilerplate with structural evidence", () => {
  it("judges a duplicating wrapper but abstains where no error is constructed", async () => {
    const smelly: ProjectFile[] = [{ filePath: "src/save-record.ts", source: SMELLY }];
    const clean: ProjectFile[] = [{ filePath: "src/save-record.ts", source: CLEAN }];

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
