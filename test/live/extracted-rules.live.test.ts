import { readFile } from "node:fs/promises";
import { describe, expect, it } from "vitest";
import { analyzeFile } from "../../src/analyze.js";
import { defaultConfig } from "../../src/config.js";
import { TypeSafeEvaluator } from "../../src/typesafe-evaluator.js";
import type { JevLintConfig } from "../../src/types.js";

const liveDescribe = process.env.RUN_LIVE_JEV === "1" ? describe : describe.skip;
const evaluator = new TypeSafeEvaluator();

const cases = [
  {
    ruleId: "jev/no-mysterious-name",
    fixture: "mysterious-name.ts",
    expectedLine: 7,
  },
  {
    ruleId: "jev/no-feature-envy",
    fixture: "feature-envy.ts",
    expectedLine: 14,
  },
] as const;

liveDescribe("live extracted-rule calibration", () => {
  it.each(cases)("$ruleId separates the smelly and clean examples", async ({
    ruleId,
    fixture,
    expectedLine,
  }) => {
    const rule = defaultConfig.rules[ruleId];
    expect(rule).toBeDefined();
    if (!rule) return;

    const source = await readFile(
      new URL(`../fixtures/rules/${fixture}`, import.meta.url),
      "utf8",
    );
    const config: JevLintConfig = { rules: { [ruleId]: rule } };
    const lineCount = source.split("\n").length;

    const diagnostics = await analyzeFile(
      {
        filePath: fixture,
        source,
        changedLines: [{ start: 1, end: lineCount }],
        config,
      },
      evaluator,
    );

    expect(diagnostics.map(({ line }) => line)).toEqual([expectedLine]);
  });
});
