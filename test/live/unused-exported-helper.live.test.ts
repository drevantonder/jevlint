import { describe, expect, it } from "vitest";
import { analyzeFile } from "../../src/analyze.js";
import { defaultConfig } from "../../src/config.js";
import { TypeSafeEvaluator } from "../../src/typesafe-evaluator.js";
import type { EvaluationRequest, Evaluator, JevLintConfig, ProjectFile } from "../../src/types.js";

const liveDescribe = process.env.RUN_LIVE_JEV === "1" ? describe : describe.skip;

class PassthroughEvaluator implements Evaluator {
  readonly delegate = new TypeSafeEvaluator();
  evaluate(request: EvaluationRequest): Promise<Record<string, number>> {
    return this.delegate.evaluate(request);
  }
}
const evaluator = new PassthroughEvaluator();

const SMELLY: ProjectFile = {
  filePath: "src/totals.ts",
  source: "export function orphanTotal(items: number[]): number {\n"
    + "  return items.reduce((sum, item) => sum + item, 0);\n"
    + "}\n",
};
const LIVE: ProjectFile = {
  filePath: "src/totals.ts",
  source: "export function liveTotal(items: number[]): number {\n"
    + "  return items.reduce((sum, item) => sum + item, 0);\n"
    + "}\n",
};
const CALLER: ProjectFile = {
  filePath: "src/app.ts",
  source: "import { liveTotal } from \"./totals.js\";\n"
    + "export function checkout(items: number[]): number {\n"
    + "  return liveTotal(items);\n"
    + "}\n",
};

async function lint(projectFiles: ProjectFile[]) {
  const changed = projectFiles.find(({ filePath }) => filePath === "src/totals.ts");
  const rule = defaultConfig.rules["jev/no-unused-exported-helper"];
  expect(changed).toBeDefined();
  expect(rule).toBeDefined();
  if (!changed || !rule) return [];
  const config: JevLintConfig = { rules: { "jev/no-unused-exported-helper": rule } };
  return analyzeFile({
    filePath: changed.filePath,
    source: changed.source,
    changedLines: [{ start: 1, end: changed.source.split("\n").length }],
    config,
    projectFiles,
  }, evaluator);
}

liveDescribe("unused exported helper with structural evidence", () => {
  it("flags the callerless export but keeps the called helper", async () => {
    const [smellyJudgments, pairedJudgments] = await Promise.all([
      lint([SMELLY]),
      lint([LIVE, CALLER]),
    ]);

    expect(smellyJudgments.length).toBeGreaterThan(0);
    expect(pairedJudgments.length).toBe(0);
  });
});
