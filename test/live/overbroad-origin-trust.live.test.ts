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
  filePath: "src/server.ts",
  source: "export function handle(req: any, res: any) {\n"
    + "  res.setHeader(\"Access-Control-Allow-Origin\", \"*\");\n"
    + "  res.setHeader(\"Access-Control-Allow-Credentials\", \"true\");\n"
    + "}\n",
};
const CLEAN: ProjectFile = {
  filePath: "src/server.ts",
  source: "const ALLOWED = [\"https://example.com\"];\n"
    + "export function handle(req: any, res: any) {\n"
    + "  if (ALLOWED.includes(req.headers.origin)) {\n"
    + "    res.setHeader(\"Access-Control-Allow-Origin\", req.headers.origin);\n"
    + "  }\n"
    + "}\n",
};

async function lint(projectFiles: ProjectFile[], evaluator: Evaluator) {
  const changed = projectFiles.find(({ filePath }) => filePath === "src/server.ts");
  const rule = defaultConfig.rules["jev/no-overbroad-origin-trust"];
  expect(changed).toBeDefined();
  expect(rule).toBeDefined();
  if (!changed || !rule) return [];
  const config: JevLintConfig = { rules: { "jev/no-overbroad-origin-trust": rule } };
  return analyzeFile({
    filePath: changed.filePath,
    source: changed.source,
    changedLines: [{ start: 1, end: changed.source.split("\n").length }],
    config,
    projectFiles,
  }, evaluator);
}

liveDescribe("overbroad origin trust with structural evidence", () => {
  it("flags a credentialed wildcard grant but keeps a named-origin check", async () => {
    const smellyEvaluator = new RecordingEvaluator();
    const cleanEvaluator = new RecordingEvaluator();
    const [smellyJudgments, cleanJudgments] = await Promise.all([
      lint([SMELLY], smellyEvaluator),
      lint([CLEAN], cleanEvaluator),
    ]);

    expect(smellyEvaluator.probabilities.get("src/server.ts")).toBeGreaterThanOrEqual(0.7);
    expect(smellyJudgments.some(({ probability }) => probability >= 0.7)).toBe(true);
    expect(cleanJudgments.every(({ probability }) => probability < 0.5)).toBe(true);
  });
});
