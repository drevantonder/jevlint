import { describe, expect, it } from "vitest";
import { analyzeChanges } from "../../src/analyze.js";
import { defaultConfig } from "../../src/config.js";
import { TypeSafeEvaluator } from "../../src/typesafe-evaluator.js";
import type { Evaluator, JevLintConfig, ProjectFile, SourceFile } from "../../src/types.js";

const liveDescribe = process.env.RUN_LIVE_JEV === "1" ? describe : describe.skip;

const OLD_LIB = "export function formatUser(name: string): string {\n"
  + "  return name.trim();\n"
  + "}\n";
const NEW_LIB = "export function formatUser(name: string): string {\n"
  + "  return name.trim();\n"
  + "}\n"
  + "export function formatUserDisplay(name: string): string {\n"
  + "  return name.trim().toLowerCase();\n"
  + "}\n";
const OLD_APP = "import { formatUser } from \"./lib.js\";\n"
  + "export function label(name: string): string {\n"
  + "  return `User: ${formatUser(name)}`;\n"
  + "}\n";
const NEW_APP = "import { formatUserDisplay } from \"./lib.js\";\n"
  + "export function label(name: string): string {\n"
  + "  return `User: ${formatUserDisplay(name)}`;\n"
  + "}\n";

async function lint(changes: SourceFile[], evaluator: Evaluator) {
  const rule = defaultConfig.rules["jev/no-change-stranded-code"];
  expect(rule).toBeDefined();
  if (!rule) return [];
  const config: JevLintConfig = { rules: { "jev/no-change-stranded-code": rule } };
  const projectFiles: ProjectFile[] = changes.map(({ filePath, source }) => ({ filePath, source }));
  return analyzeChanges({ changes, config, projectFiles }, evaluator);
}

liveDescribe("change stranded code with before/after evidence", () => {
  it("judges stranded code but abstains when the old implementation leaves", async () => {
    const stranded: SourceFile[] = [
      {
        filePath: "src/lib.ts",
        source: NEW_LIB,
        oldSource: OLD_LIB,
        changedLines: [{ start: 4, end: 6 }],
      },
      {
        filePath: "src/app.ts",
        source: NEW_APP,
        oldSource: OLD_APP,
        changedLines: [{ start: 1, end: 3 }],
      },
    ];
    const removed: SourceFile[] = [
      {
        filePath: "src/lib.ts",
        source: NEW_LIB.split("\n").slice(3).join("\n"),
        oldSource: OLD_LIB,
        changedLines: [{ start: 1, end: 3 }],
      },
      {
        filePath: "src/app.ts",
        source: NEW_APP,
        oldSource: OLD_APP,
        changedLines: [{ start: 1, end: 3 }],
      },
    ];

    const [strandedJudgments, removedJudgments] = await Promise.all([
      lint(stranded, new TypeSafeEvaluator({ apiKey: process.env.JEVLINT_TYPESAFE_API_KEY ?? "" })),
      lint(removed, new TypeSafeEvaluator({ apiKey: process.env.JEVLINT_TYPESAFE_API_KEY ?? "" })),
    ]);

    expect(strandedJudgments.length).toBeGreaterThan(0);
    expect(strandedJudgments[0]?.ruleId).toBe("jev/no-change-stranded-code");
    expect(removedJudgments).toEqual([]);
  });
});
