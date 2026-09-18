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
  filePath: "src/db.ts",
  source: "let connection: string | undefined;\n"
    + "export function connect(url: string): void {\n"
    + "  connection = url;\n"
    + "}\n"
    + "export function query(sql: string): string {\n"
    + "  return `${connection}:${sql}`;\n"
    + "}\n",
};
const GUARDED: ProjectFile = {
  filePath: "src/db.ts",
  source: "let connection: string | undefined;\n"
    + "export function connect(url: string): void {\n"
    + "  connection = url;\n"
    + "}\n"
    + "export function query(sql: string): string {\n"
    + "  if (!connection) throw new Error(\"not connected\");\n"
    + "  return `${connection}:${sql}`;\n"
    + "}\n",
};

async function lint(projectFiles: ProjectFile[], evaluator: Evaluator) {
  const changed = projectFiles[0];
  const rule = defaultConfig.rules["jev/no-temporal-call-coupling"];
  expect(changed).toBeDefined();
  expect(rule).toBeDefined();
  if (!changed || !rule) return [];
  const config: JevLintConfig = { rules: { "jev/no-temporal-call-coupling": rule } };
  return analyzeFile({
    filePath: changed.filePath,
    source: changed.source,
    changedLines: [{ start: 1, end: changed.source.split("\n").length }],
    config,
    projectFiles,
  }, evaluator);
}

liveDescribe("temporal call coupling with structural evidence", () => {
  it("flags an unenforced setup handshake but keeps the guarded reader", async () => {
    const smellyEvaluator = new RecordingEvaluator();
    const guardedEvaluator = new RecordingEvaluator();
    const [smellyJudgments, guardedJudgments] = await Promise.all([
      lint([SMELLY], smellyEvaluator),
      lint([GUARDED], guardedEvaluator),
    ]);

    expect(smellyEvaluator.probabilities.get("src/db.ts")).toBeGreaterThanOrEqual(0.85);
    expect(smellyJudgments.some(({ probability }) => probability >= 0.85)).toBe(true);
    expect(guardedJudgments.every(({ probability }) => probability < 0.5)).toBe(true);
  });
});
