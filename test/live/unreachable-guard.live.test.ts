import { describe, expect, it } from "vitest";
import { analyzeFile } from "../../src/analyze.js";
import { defaultConfig } from "../../src/config.js";
import { TypeSafeEvaluator } from "../../src/typesafe-evaluator.js";
import type { EvaluationRequest, Evaluator, JevLintConfig, ProjectFile } from "../../src/types.js";

const liveDescribe = process.env.RUN_LIVE_JEV === "1" ? describe : describe.skip;

class RecordingEvaluator implements Evaluator {
  readonly probabilities = new Map<string, number>();
  readonly delegate = new TypeSafeEvaluator({ apiKey: process.env.TYPESAFE_API_KEY ?? "" });
  async evaluate(request: EvaluationRequest): Promise<Record<string, number>> {
    const answers = await this.delegate.evaluate(request);
    const probability = answers.q0;
    if (probability !== undefined) this.probabilities.set(request.state.file.path, probability);
    return answers;
  }
}

const SMELLY: ProjectFile = {
  filePath: "src/render.ts",
  source: "function repeat(count: number, word: string): string {\n"
    + "  if (typeof count !== \"number\") return \"\";\n"
    + "  return word.repeat(count);\n"
    + "}\n"
    + "export function cheers(): string {\n"
    + "  return repeat(3, \"ho\");\n"
    + "}\n"
    + "export function echoWord(): string {\n"
    + "  return repeat(2, \"hi\");\n"
    + "}\n"
    + "export function chant(): string {\n"
    + "  return repeat(5, \"yo\");\n"
    + "}\n"
    + "export function toast(): string {\n"
    + "  return repeat(1, \"hey\");\n"
    + "}\n",
};
const SELF_DESCRIBING: ProjectFile = {
  filePath: "src/render.ts",
  source: "export function render(opts: { title: string } | null): string {\n"
    + "  if (!opts) return \"untitled\";\n"
    + "  return opts.title;\n"
    + "}\n",
};

async function lint(projectFiles: ProjectFile[], evaluator: Evaluator) {
  const changed = projectFiles.find(({ filePath }) => filePath === "src/render.ts");
  const rule = defaultConfig.rules["jev/no-unreachable-guard"];
  expect(changed).toBeDefined();
  expect(rule).toBeDefined();
  if (!changed || !rule) return [];
  const config: JevLintConfig = { rules: { "jev/no-unreachable-guard": rule } };
  return analyzeFile({
    filePath: changed.filePath,
    source: changed.source,
    changedLines: [{ start: 1, end: changed.source.split("\n").length }],
    config,
    projectFiles,
  }, evaluator);
}

liveDescribe("unreachable guard with structural evidence", () => {
  it("flags a guard no caller can trigger but keeps a nullable contract", async () => {
    const smellyEvaluator = new RecordingEvaluator();
    const cleanEvaluator = new RecordingEvaluator();
    const [smellyJudgments, cleanJudgments] = await Promise.all([
      lint([SMELLY], smellyEvaluator),
      lint([SELF_DESCRIBING], cleanEvaluator),
    ]);

    // Calibration note: Jev scores unreachable guards with moderate confidence
    // (observed 0.77 for the smelly fixture) — same-repo callers cannot rule out
    // future callers, and cheap guards carry option value. The bar asserts
    // separation from the clean fixture, not high-confidence calibration.
    expect(smellyEvaluator.probabilities.get("src/render.ts")).toBeGreaterThanOrEqual(0.7);
    expect(smellyJudgments.some(({ probability }) => probability >= 0.7)).toBe(true);
    expect(cleanJudgments.every(({ probability }) => probability < 0.5)).toBe(true);
  });
});
