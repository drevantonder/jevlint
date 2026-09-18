import { describe, expect, it } from "vitest";
import { analyzeFile } from "../../src/analyze.js";
import { defaultConfig } from "../../src/config.js";
import { TypeSafeEvaluator } from "../../src/typesafe-evaluator.js";
import type { EvaluationRequest, Evaluator, JevLintConfig, ProjectFile } from "../../src/types.js";

const RULE = "jev/no-singly-owned-lazy-shared-state";
const liveDescribe = process.env.RUN_LIVE_JEV === "1" ? describe : describe.skip;

class RecordingEvaluator implements Evaluator {
  probability: number | undefined;
  readonly delegate = new TypeSafeEvaluator({ apiKey: process.env.JEVLINT_TYPESAFE_API_KEY ?? "" });

  async evaluate(request: EvaluationRequest): Promise<Record<string, number>> {
    const answers = await this.delegate.evaluate(request);
    this.probability = answers.q0;
    return answers;
  }
}

const SMELLY: ProjectFile = {
  filePath: "src/cache.ts",
  source: "import { loadSettings, type Settings } from \"./settings.js\";\n"
    + "let cached: Settings | null = null;\n"
    + "export function getSettings(): Settings {\n"
    + "  if (!cached) cached = loadSettings();\n"
    + "  return cached;\n"
    + "}\n",
};
const SUPPORT: ProjectFile = {
  filePath: "src/settings.ts",
  source: "export type Settings = { theme: string };\n"
    + "export function loadSettings(): Settings {\n"
    + "  return { theme: \"light\" };\n"
    + "}\n",
};
const CLEAN: ProjectFile = {
  filePath: "src/clean-cache.ts",
  source: "import { loadSettings, type Settings } from \"./settings.js\";\n"
    + "const cached: Settings = loadSettings();\n"
    + "export function getSettings(): Settings {\n"
    + "  return cached;\n"
    + "}\n",
};

async function lint(changed: ProjectFile, evaluator: Evaluator, projectFiles: ProjectFile[]) {
  const rule = defaultConfig.rules[RULE];
  expect(rule).toBeDefined();
  if (!rule) return [];
  const config: JevLintConfig = { rules: { [RULE]: rule } };
  return analyzeFile({
    filePath: changed.filePath,
    source: changed.source,
    changedLines: [{ start: 1, end: changed.source.split("\n").length }],
    config,
    projectFiles,
  }, evaluator);
}

liveDescribe("singly owned lazy shared state with structural evidence", () => {
  it("flags first-use creation while load-time initialization abstains", async () => {
    const evaluator = new RecordingEvaluator();
    const [smellyJudgments, cleanJudgments] = await Promise.all([
      lint(SMELLY, evaluator, [SMELLY, SUPPORT]),
      lint(CLEAN, new RecordingEvaluator(), [CLEAN, SUPPORT]),
    ]);
    expect(smellyJudgments.map(({ ruleId }) => ruleId)).toContain(RULE);
    expect(cleanJudgments).toEqual([]);
    expect(evaluator.probability).toBeGreaterThanOrEqual(0.7);
  });
});
