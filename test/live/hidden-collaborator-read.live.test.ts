import { describe, expect, it } from "vitest";
import { analyzeFile } from "../../src/analyze.js";
import { defaultConfig } from "../../src/config.js";
import { TypeSafeEvaluator } from "../../src/typesafe-evaluator.js";
import type { EvaluationRequest, Evaluator, JevLintConfig, ProjectFile } from "../../src/types.js";

const liveDescribe = process.env.RUN_LIVE_JEV === "1" ? describe : describe.skip;

class RecordingEvaluator implements Evaluator {
  readonly probabilities = new Map<string, number>();
  readonly delegate = new TypeSafeEvaluator();
  async evaluate(request: EvaluationRequest): Promise<Record<string, number>> {
    const answers = await this.delegate.evaluate(request);
    const probability = answers.q0;
    if (probability !== undefined) this.probabilities.set(request.state.file.path, probability);
    return answers;
  }
}

const FLAGS: ProjectFile = {
  filePath: "src/flags.ts",
  source: "export const flags = { vip: new Set<string>() };\n"
    + "export function enrollVip(id: string): void {\n"
    + "  flags.vip.add(id);\n"
    + "}\n",
};
const SMELLY: ProjectFile = {
  filePath: "src/policy.ts",
  source: "import { flags } from \"./flags.js\";\n"
    + "export function discount(userId: string): number {\n"
    + "  return flags.vip.has(userId) ? 0.2 : 0;\n"
    + "}\n",
};
const CLEAN: ProjectFile = {
  filePath: "src/policy.ts",
  source: "import { format } from \"./format.js\";\n"
    + "export function label(total: number): string {\n"
    + "  return format(total);\n"
    + "}\n",
};

async function lint(projectFiles: ProjectFile[], evaluator: Evaluator) {
  const changed = projectFiles.find(({ filePath }) => filePath === "src/policy.ts");
  const rule = defaultConfig.rules["jev/no-hidden-collaborator-read"];
  expect(changed).toBeDefined();
  expect(rule).toBeDefined();
  if (!changed || !rule) return [];
  const config: JevLintConfig = { rules: { "jev/no-hidden-collaborator-read": rule } };
  return analyzeFile({
    filePath: changed.filePath,
    source: changed.source,
    changedLines: [{ start: 1, end: changed.source.split("\n").length }],
    config,
    projectFiles,
  }, evaluator);
}

liveDescribe("hidden collaborator read with structural evidence", () => {
  it("flags imported state deciding a branch but keeps visible call collaboration", async () => {
    const smellyEvaluator = new RecordingEvaluator();
    const cleanEvaluator = new RecordingEvaluator();
    const format: ProjectFile = {
      filePath: "src/format.ts",
      source: "export function format(total: number): string {\n  return String(total);\n}\n",
    };
    const [smellyJudgments, cleanJudgments] = await Promise.all([
      lint([SMELLY, FLAGS], smellyEvaluator),
      lint([CLEAN, format], cleanEvaluator),
    ]);

    expect(smellyEvaluator.probabilities.get("src/policy.ts")).toBeGreaterThanOrEqual(0.85);
    expect(smellyJudgments.some(({ probability }) => probability >= 0.85)).toBe(true);
    expect(cleanJudgments.every(({ probability }) => probability < 0.5)).toBe(true);
  });
});
