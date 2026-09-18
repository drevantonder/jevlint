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
  filePath: "src/session.ts",
  source: "let activeSession: string | null = null;\n"
    + "let cartTotal = 0;\n"
    + "let discountApplied = false;\n"
    + "\n"
    + "function startSession(userId: string): void {\n"
    + "  activeSession = userId;\n"
    + "}\n"
    + "\n"
    + "function loadCartTotal(items: number[]): void {\n"
    + "  cartTotal = items.reduce((sum, item) => sum + item, 0);\n"
    + "}\n"
    + "\n"
    + "function applyLoyaltyDiscount(): void {\n"
    + "  if (activeSession !== null && cartTotal > 100) {\n"
    + "    cartTotal = cartTotal - 10;\n"
    + "    discountApplied = true;\n"
    + "  }\n"
    + "}\n"
    + "\n"
    + "export function checkout(userId: string, items: number[]): number {\n"
    + "  startSession(userId);\n"
    + "  loadCartTotal(items);\n"
    + "  applyLoyaltyDiscount();\n"
    + "  return cartTotal;\n"
    + "}\n",
};

const REUSED: ProjectFile = {
  filePath: "src/compute.ts",
  source: "function double(n: number): number {\n"
    + "  return n * 2;\n"
    + "}\n"
    + "\n"
    + "function inc(n: number): number {\n"
    + "  return n + 1;\n"
    + "}\n"
    + "\n"
    + "function square(n: number): number {\n"
    + "  return n * n;\n"
    + "}\n"
    + "\n"
    + "export function pipeline(n: number): number {\n"
    + "  const a = double(n);\n"
    + "  const b = inc(a);\n"
    + "  return square(b);\n"
    + "}\n"
    + "\n"
    + "export function shifted(n: number): number {\n"
    + "  return inc(square(n));\n"
    + "}\n",
};

async function lint(projectFiles: ProjectFile[], evaluator: Evaluator) {
  const changed = projectFiles.find(({ filePath }) => filePath.endsWith(".ts"));
  const rule = defaultConfig.rules["jev/no-fragmented-stateful-procedure"];
  expect(changed).toBeDefined();
  expect(rule).toBeDefined();
  if (!changed || !rule) return [];
  const config: JevLintConfig = { rules: { "jev/no-fragmented-stateful-procedure": rule } };
  return analyzeFile({
    filePath: changed.filePath,
    source: changed.source,
    changedLines: [{ start: 1, end: changed.source.split("\n").length }],
    config,
    projectFiles,
  }, evaluator);
}

liveDescribe("fragmented stateful procedure with structural evidence", () => {
  it("flags the scattered state transitions but keeps reused pure helpers", async () => {
    const smellyEvaluator = new RecordingEvaluator();
    const cleanEvaluator = new RecordingEvaluator();
    const [smellyJudgments, cleanJudgments] = await Promise.all([
      lint([SMELLY], smellyEvaluator),
      lint([REUSED], cleanEvaluator),
    ]);

    expect(smellyEvaluator.probabilities.get("src/session.ts")).toBeGreaterThanOrEqual(0.85);
    expect(smellyJudgments.some(({ probability }) => probability >= 0.85)).toBe(true);
    expect(cleanJudgments.every(({ probability }) => probability < 0.5)).toBe(true);
  });
});
