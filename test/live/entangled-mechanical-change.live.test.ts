import { describe, expect, it } from "vitest";
import { analyzeChanges } from "../../src/analyze.js";
import { defaultConfig } from "../../src/config.js";
import { TypeSafeEvaluator } from "../../src/typesafe-evaluator.js";
import type { Evaluator, JevLintConfig, ProjectFile, SourceFile } from "../../src/types.js";

const liveDescribe = process.env.RUN_LIVE_JEV === "1" ? describe : describe.skip;
const evaluator = new TypeSafeEvaluator({ apiKey: process.env.TYPESAFE_API_KEY ?? "" });

const oldSource = `export function add(a: number, b: number): number {
  return a + b;
}
export function mul(a: number, b: number): number {
    return a  *  b;
}
`;

const entangledSource = `export function add(a: number, b: number): number {
    return a + b;
}
export function mul(a: number, b: number): number {
    return a  *  b;
}
export function sub(a: number, b: number): number {
  return a - b;
}
`;

function files(source: string, changedLines: SourceFile["changedLines"]): SourceFile[] {
  return [{ filePath: "src/math.ts", source, oldSource, changedLines }];
}

function project(source: string): ProjectFile[] {
  return [{ filePath: "src/math.ts", source }];
}

async function lint(changeFiles: SourceFile[], projectFiles: ProjectFile[], judge: Evaluator) {
  const rule = defaultConfig.rules["jev/no-entangled-mechanical-change"];
  expect(rule).toBeDefined();
  if (!rule) return [];
  const config: JevLintConfig = { rules: { "jev/no-entangled-mechanical-change": rule } };
  return analyzeChanges({ changes: changeFiles, config, projectFiles }, judge);
}

liveDescribe("entangled mechanical change calibration", () => {
  it("flags noise-obscured behavior but keeps a pure behavioral change", async () => {
    const [entangledJudgments, cleanJudgments] = await Promise.all([
      lint(
        files(entangledSource, [{ start: 2, end: 2 }, { start: 7, end: 9 }]),
        project(entangledSource),
        evaluator,
      ),
      lint(
        files(entangledSource, [{ start: 7, end: 9 }]),
        project(entangledSource),
        evaluator,
      ),
    ]);

    expect(entangledJudgments).toHaveLength(1);
    expect(entangledJudgments[0]?.probability).toBeGreaterThanOrEqual(0);
    expect(entangledJudgments[0]?.probability).toBeLessThanOrEqual(1);
    expect(cleanJudgments).toHaveLength(0);
  });
});
