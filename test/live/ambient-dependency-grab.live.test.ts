import { describe, expect, it } from "vitest";
import { analyzeFile } from "../../src/analyze.js";
import { defaultConfig } from "../../src/config.js";
import { TypeSafeEvaluator } from "../../src/typesafe-evaluator.js";
import type { EvaluationRequest, Evaluator, JevLintConfig, ProjectFile } from "../../src/types.js";

const RULE = "jev/no-ambient-dependency-grab";
const liveDescribe = process.env.RUN_LIVE_JEV === "1" ? describe : describe.skip;

class RecordingEvaluator implements Evaluator {
  probability: number | undefined;
  readonly delegate = new TypeSafeEvaluator();

  async evaluate(request: EvaluationRequest): Promise<Record<string, number>> {
    const answers = await this.delegate.evaluate(request);
    this.probability = answers.q0;
    return answers;
  }
}

const SMELLY: ProjectFile = {
  filePath: "src/orders.ts",
  source: "import { Db } from \"./db.js\";\n"
    + "export function placeOrder(id: string) {\n"
    + "  const db = Db.getInstance();\n"
    + "  db.rows.push({ id });\n"
    + "  return db.rows.length;\n"
    + "}\n",
};
const SUPPORT: ProjectFile = {
  filePath: "src/db.ts",
  source: "export class Db {\n"
    + "  static getInstance(): Db { return new Db(); }\n"
    + "  rows: { id: string }[] = [];\n"
    + "}\n",
};
const CALLER: ProjectFile = {
  filePath: "src/route.ts",
  source: "import { placeOrder } from \"./orders.js\";\n"
    + "export function handleCheckout(id: string) {\n"
    + "  return placeOrder(id);\n"
    + "}\n",
};
const CLEAN: ProjectFile = {
  filePath: "src/clean-orders.ts",
  source: "import type { Db } from \"./db.js\";\n"
    + "export function placeOrder(db: Db, id: string) {\n"
    + "  db.rows.push({ id });\n"
    + "  return db.rows.length;\n"
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

liveDescribe("ambient dependency grab with structural evidence", () => {
  it("flags singleton grabs while explicit parameters abstain", async () => {
    const evaluator = new RecordingEvaluator();
    const [smellyJudgments, cleanJudgments] = await Promise.all([
      lint(SMELLY, evaluator, [SMELLY, SUPPORT, CALLER]),
      lint(CLEAN, new RecordingEvaluator(), [CLEAN, SUPPORT]),
    ]);
    expect(smellyJudgments.map(({ ruleId }) => ruleId)).toContain(RULE);
    expect(cleanJudgments).toEqual([]);
    expect(evaluator.probability).toBeGreaterThanOrEqual(0.7);
  });
});
