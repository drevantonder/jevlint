import { describe, expect, it } from "vitest";
import { analyzeFile } from "../../src/analyze.js";
import { defaultConfig } from "../../src/config.js";
import { TypeSafeEvaluator } from "../../src/typesafe-evaluator.js";
import type { JevLintConfig, ProjectFile } from "../../src/types.js";

const liveDescribe = process.env.RUN_LIVE_JEV === "1" ? describe : describe.skip;
const evaluator = new TypeSafeEvaluator({ apiKey: process.env.JEVLINT_TYPESAFE_API_KEY ?? "" });

const geometrySource = `export type Shape =
  | { kind: "circle"; radius: number }
  | { kind: "square"; side: number }
  | { kind: "triangle"; base: number; height: number };

export function area(shape: Shape): number {
  switch (shape.kind) {
    case "circle":
      return Math.PI * shape.radius * shape.radius;
    case "square":
      return shape.side * shape.side;
    case "triangle":
      return (shape.base * shape.height) / 2;
  }
}
`;

const labelSource = `export function label(mode: string): string {
  if (mode === "fast") return "F";
  return "S";
}
`;

async function lint(source: string, projectFiles: ProjectFile[]) {
  const rule = defaultConfig.rules["jev/no-type-code-dispatch"];
  expect(rule).toBeDefined();
  if (!rule) return [];
  const config: JevLintConfig = { rules: { "jev/no-type-code-dispatch": rule } };
  return analyzeFile({
    filePath: "src/shape.ts",
    source,
    changedLines: [{ start: 1, end: source.split("\n").length }],
    config,
    projectFiles,
  }, evaluator);
}

liveDescribe("type code dispatch with structural evidence", () => {
  it("judges a domain-code switch but abstains on a transient branch", async () => {
    const smelly: ProjectFile[] = [{ filePath: "src/shape.ts", source: geometrySource }];
    const clean: ProjectFile[] = [{ filePath: "src/shape.ts", source: labelSource }];

    const [smellyJudgments, cleanJudgments] = await Promise.all([
      lint(geometrySource, smelly),
      lint(labelSource, clean),
    ]);

    expect(smellyJudgments).toHaveLength(1);
    expect(smellyJudgments[0]?.probability).toBeGreaterThanOrEqual(0);
    expect(smellyJudgments[0]?.probability).toBeLessThanOrEqual(1);
    expect(cleanJudgments).toHaveLength(0);
  });
});
