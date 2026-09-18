import { describe, expect, it } from "vitest";
import { analyzeFile } from "../../src/analyze.js";
import { defaultConfig } from "../../src/config.js";
import { TypeSafeEvaluator } from "../../src/typesafe-evaluator.js";
import type { EvaluationRequest, Evaluator, JevLintConfig, ProjectFile } from "../../src/types.js";

const liveDescribe = process.env.RUN_LIVE_JEV === "1" ? describe : describe.skip;

class RecordingEvaluator implements Evaluator {
  readonly probabilities = new Map<string, number>();
  readonly delegate = new TypeSafeEvaluator({ apiKey: process.env.JEVLINT_TYPESAFE_API_KEY ?? "" });
  async evaluate(request: EvaluationRequest): Promise<Record<string, number>> {
    const answers = await this.delegate.evaluate(request);
    const probability = answers.q0;
    if (probability !== undefined) this.probabilities.set(request.state.file.path, probability);
    return answers;
  }
}

const SMELLY: ProjectFile = {
  filePath: "src/fetch.ts",
  source: "export function fetchWithTimeout(url: string, ms: number): Promise<string> {\n"
    + "  let timer: ReturnType<typeof setTimeout>;\n"
    + "  const timeout = new Promise<never>((_, reject) => {\n"
    + "    timer = setTimeout(() => reject(new Error(\"request timed out\")), ms);\n"
    + "  });\n"
    + "  return Promise.race([fetch(url).then((response) => response.text()), timeout])\n"
    + "    .finally(() => clearTimeout(timer));\n"
    + "}\n",
};
const PAIRED: ProjectFile = {
  filePath: "src/fetch.ts",
  source: "export function fetchBounded(url: string): Promise<string> {\n"
    + "  return fetch(url, { signal: AbortSignal.timeout(5000) }).then((response) => response.text());\n"
    + "}\n",
};

async function lint(projectFiles: ProjectFile[], evaluator: Evaluator) {
  const changed = projectFiles.find(({ filePath }) => filePath === "src/fetch.ts");
  const rule = defaultConfig.rules["jev/no-hand-rolled-promise-timeout"];
  expect(changed).toBeDefined();
  expect(rule).toBeDefined();
  if (!changed || !rule) return [];
  const config: JevLintConfig = { rules: { "jev/no-hand-rolled-promise-timeout": rule } };
  return analyzeFile({
    filePath: changed.filePath,
    source: changed.source,
    changedLines: [{ start: 1, end: changed.source.split("\n").length }],
    config,
    projectFiles,
  }, evaluator);
}

liveDescribe("hand rolled promise timeout with structural evidence", () => {
  it("flags a manual race but keeps the platform timeout", async () => {
    const smellyEvaluator = new RecordingEvaluator();
    const cleanEvaluator = new RecordingEvaluator();
    const [smellyJudgments, cleanJudgments] = await Promise.all([
      lint([SMELLY], smellyEvaluator),
      lint([PAIRED], cleanEvaluator),
    ]);

    expect(smellyEvaluator.probabilities.get("src/fetch.ts")).toBeGreaterThanOrEqual(0.85);
    expect(smellyJudgments.some(({ probability }) => probability >= 0.85)).toBe(true);
    expect(cleanJudgments.every(({ probability }) => probability < 0.5)).toBe(true);
  });
});
