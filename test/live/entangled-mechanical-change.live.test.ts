import { describe, expect, it } from "vitest";
import { analyzeChanges } from "../../src/analyze.js";
import { defaultConfig } from "../../src/config.js";
import { TypeSafeEvaluator } from "../../src/typesafe-evaluator.js";
import type { Evaluator, JevLintConfig, ProjectFile, SourceFile } from "../../src/types.js";

const liveDescribe = process.env.RUN_LIVE_JEV === "1" ? describe : describe.skip;

const OLD_LIB = "import { b } from \"./b.js\";\n"
  + "import { a } from \"./a.js\";\n"
  + "export function total(x: number): number {\n"
  + "  return x + 1;\n"
  + "}\n";
const ENTANGLED = "import { a } from \"./a.js\";\n"
  + "import { b } from \"./b.js\";\n"
  + "export function total(x: number): number {\n"
  + "  return x + 2;\n"
  + "}\n";
const MECHANICAL_ONLY = "import { a } from \"./a.js\";\n"
  + "import { b } from \"./b.js\";\n"
  + "export function total(x: number): number {\n"
  + "  return x + 1;\n"
  + "}\n";

async function lint(changes: SourceFile[], evaluator: Evaluator) {
  const rule = defaultConfig.rules["jev/no-entangled-mechanical-change"];
  expect(rule).toBeDefined();
  if (!rule) return [];
  const config: JevLintConfig = { rules: { "jev/no-entangled-mechanical-change": rule } };
  const projectFiles: ProjectFile[] = changes.map(({ filePath, source }) => ({ filePath, source }));
  return analyzeChanges({ changes, config, projectFiles }, evaluator);
}

function change(source: string): SourceFile[] {
  return [{
    filePath: "src/lib.ts",
    source,
    oldSource: OLD_LIB,
    changedLines: [{ start: 1, end: source.split("\n").length }],
  }];
}

liveDescribe("entangled mechanical change with hunk layer evidence", () => {
  it("judges an entangled hunk but abstains on a mechanical-only diff", async () => {
    const [entangledJudgments, mechanicalJudgments] = await Promise.all([
      lint(change(ENTANGLED), new TypeSafeEvaluator()),
      lint(change(MECHANICAL_ONLY), new TypeSafeEvaluator()),
    ]);

    expect(entangledJudgments.length).toBeGreaterThan(0);
    expect(entangledJudgments[0]?.ruleId).toBe("jev/no-entangled-mechanical-change");
    expect(mechanicalJudgments).toEqual([]);
  });
});
