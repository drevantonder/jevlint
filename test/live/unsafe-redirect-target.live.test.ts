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
  filePath: "src/auth.ts",
  source: "export function login(req: any, res: any) {\n"
    + "  res.redirect(req.query.next);\n"
    + "}\n",
};
const CLEAN: ProjectFile = {
  filePath: "src/auth.ts",
  source: "const ALLOWED = [\"/home\", \"/dashboard\"];\n"
    + "export function login(req: any, res: any) {\n"
    + "  const next = ALLOWED.includes(req.query.next) ? req.query.next : \"/home\";\n"
    + "  res.redirect(next);\n"
    + "}\n",
};

async function lint(projectFiles: ProjectFile[], evaluator: Evaluator) {
  const changed = projectFiles.find(({ filePath }) => filePath === "src/auth.ts");
  const rule = defaultConfig.rules["jev/no-unsafe-redirect-target"];
  expect(changed).toBeDefined();
  expect(rule).toBeDefined();
  if (!changed || !rule) return [];
  const config: JevLintConfig = { rules: { "jev/no-unsafe-redirect-target": rule } };
  return analyzeFile({
    filePath: changed.filePath,
    source: changed.source,
    changedLines: [{ start: 1, end: changed.source.split("\n").length }],
    config,
    projectFiles,
  }, evaluator);
}

liveDescribe("unsafe redirect target with structural evidence", () => {
  it("flags an unchecked request-derived target but keeps an allow-listed one", async () => {
    const smellyEvaluator = new RecordingEvaluator();
    const cleanEvaluator = new RecordingEvaluator();
    const [smellyJudgments, cleanJudgments] = await Promise.all([
      lint([SMELLY], smellyEvaluator),
      lint([CLEAN], cleanEvaluator),
    ]);

    expect(smellyEvaluator.probabilities.get("src/auth.ts")).toBeGreaterThanOrEqual(0.7);
    expect(smellyJudgments.some(({ probability }) => probability >= 0.7)).toBe(true);
    expect(cleanJudgments.every(({ probability }) => probability < 0.5)).toBe(true);
  });
});
