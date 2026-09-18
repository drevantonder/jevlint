import { describe, expect, it } from "vitest";
import { analyzeFile } from "../../src/analyze.js";
import { defaultConfig } from "../../src/config.js";
import { TypeSafeEvaluator } from "../../src/typesafe-evaluator.js";
import type { Evaluator, JevLintConfig, ProjectFile } from "../../src/types.js";

const liveDescribe = process.env.RUN_LIVE_JEV === "1" ? describe : describe.skip;

const LIB = "export function normalizeId(input: string): string {\n"
  + "  if (input === \"root\") return \"root\";\n"
  + "  return input.trim().toLowerCase();\n"
  + "}\n";
const APP = "import { normalizeId } from \"./lib.js\";\n"
  + "export function keyFor(input: string): string {\n"
  + "  return normalizeId(\"root\");\n"
  + "}\n";
const PLAIN_LIB = "export function slug(input: string): string {\n"
  + "  return input.trim().toLowerCase();\n"
  + "}\n";

async function lint(source: string, projectFiles: ProjectFile[], evaluator: Evaluator) {
  const rule = defaultConfig.rules["jev/no-unpinned-compat-quirk"];
  expect(rule).toBeDefined();
  if (!rule) return [];
  const config: JevLintConfig = { rules: { "jev/no-unpinned-compat-quirk": rule } };
  return analyzeFile({
    filePath: "src/lib.ts",
    source,
    changedLines: [{ start: 1, end: source.split("\n").length }],
    config,
    projectFiles,
  }, evaluator);
}

liveDescribe("unpinned compat quirk with caller dependence evidence", () => {
  it("judges an exercised quirk but abstains without callers", async () => {
    const withCaller: ProjectFile[] = [
      { filePath: "src/lib.ts", source: LIB },
      { filePath: "src/app.ts", source: APP },
    ];
    const withoutCaller: ProjectFile[] = [{ filePath: "src/lib.ts", source: PLAIN_LIB }];

    const [quirkJudgments, cleanJudgments] = await Promise.all([
      lint(LIB, withCaller, new TypeSafeEvaluator({ apiKey: process.env.TYPESAFE_API_KEY ?? "" })),
      lint(PLAIN_LIB, withoutCaller, new TypeSafeEvaluator({ apiKey: process.env.TYPESAFE_API_KEY ?? "" })),
    ]);

    expect(quirkJudgments.length).toBeGreaterThan(0);
    expect(quirkJudgments[0]?.ruleId).toBe("jev/no-unpinned-compat-quirk");
    expect(cleanJudgments).toEqual([]);
  });
});
