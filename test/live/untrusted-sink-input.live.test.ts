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
  filePath: "src/users.ts",
  source: "import { db } from \"./db.js\";\n"
    + "export function findUser(userId: string): unknown {\n"
    + "  return db.query(`SELECT * FROM users WHERE id = ${userId}`);\n"
    + "}\n",
};
const PARAMETERIZED: ProjectFile = {
  filePath: "src/users.ts",
  source: "import { db } from \"./db.js\";\n"
    + "const TABLE = \"users\";\n"
    + "export function countAll(): unknown {\n"
    + "  return db.query(`SELECT COUNT(*) FROM ${TABLE}`);\n"
    + "}\n",
};

async function lint(projectFiles: ProjectFile[], evaluator: Evaluator) {
  const changed = projectFiles.find(({ filePath }) => filePath === "src/users.ts");
  const rule = defaultConfig.rules["jev/no-untrusted-sink-input"];
  expect(changed).toBeDefined();
  expect(rule).toBeDefined();
  if (!changed || !rule) return [];
  const config: JevLintConfig = { rules: { "jev/no-untrusted-sink-input": rule } };
  return analyzeFile({
    filePath: changed.filePath,
    source: changed.source,
    changedLines: [{ start: 1, end: changed.source.split("\n").length }],
    config,
    projectFiles,
  }, evaluator);
}

liveDescribe("untrusted sink input with structural evidence", () => {
  it("flags interpolated handler input but abstains on constant interpolation", async () => {
    const smellyEvaluator = new RecordingEvaluator();
    const cleanEvaluator = new RecordingEvaluator();
    const [smellyJudgments, cleanJudgments] = await Promise.all([
      lint([SMELLY], smellyEvaluator),
      lint([PARAMETERIZED], cleanEvaluator),
    ]);

    expect(smellyEvaluator.probabilities.get("src/users.ts")).toBeGreaterThanOrEqual(0.85);
    expect(smellyJudgments.some(({ probability }) => probability >= 0.85)).toBe(true);
    expect(cleanJudgments).toHaveLength(0);
  });
});
