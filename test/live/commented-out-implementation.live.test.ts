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
  filePath: "src/pricing.ts",
  source: "export function priceLabel(cents: number): string {\n"
    + "  return `$${(cents / 100).toFixed(2)}`;\n"
    + "}\n"
    + "// function oldPriceLabel(cents: number): string {\n"
    + "//   return \"$\" + cents;\n"
    + "// }\n",
};
const PAIRED: ProjectFile = {
  filePath: "src/pricing.ts",
  source: "// Formats cents using the shared currency helper.\n"
    + "export function priceLabel(cents: number): string {\n"
    + "  return `$${(cents / 100).toFixed(2)}`;\n"
    + "}\n",
};

async function lint(projectFiles: ProjectFile[]) {
  const changed = projectFiles.find(({ filePath }) => filePath === "src/pricing.ts");
  const rule = defaultConfig.rules["jev/no-commented-out-implementation"];
  expect(changed).toBeDefined();
  expect(rule).toBeDefined();
  if (!changed || !rule) return [];
  const config: JevLintConfig = { rules: { "jev/no-commented-out-implementation": rule } };
  return analyzeFile({
    filePath: changed.filePath,
    source: changed.source,
    changedLines: [{ start: 1, end: changed.source.split("\n").length }],
    config,
    projectFiles,
  }, evaluator);
}

liveDescribe("commented out implementation with structural evidence", () => {
  it("flags the disabled implementation but keeps prose documentation", async () => {
    const [smellyJudgments, pairedJudgments] = await Promise.all([
      lint([SMELLY]),
      lint([PAIRED]),
    ]);

    expect(smellyJudgments.length).toBeGreaterThan(0);
    expect(pairedJudgments.length).toBe(0);
  });
});
