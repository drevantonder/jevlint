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
  filePath: "src/refund.ts",
  source: "import { logger, payments } from \"./services.js\";\n"
    + "export async function refundPayment(paymentId: string) {\n"
    + "  try {\n"
    + "    await payments.refund(paymentId);\n"
    + "  } catch (error) {\n"
    + "    logger.error(\"refund failed\", { paymentId, error });\n"
    + "    throw error;\n"
    + "  }\n"
    + "  return { paymentId, status: \"refunded\" as const };\n"
    + "}\n",
};
const ABSORBING: ProjectFile = {
  filePath: "src/refund.ts",
  source: "import { logger, payments } from \"./services.js\";\n"
    + "export async function refundPayment(paymentId: string) {\n"
    + "  try {\n"
    + "    await payments.refund(paymentId);\n"
    + "  } catch (error) {\n"
    + "    logger.error(\"refund failed\", { paymentId, error });\n"
    + "    return { paymentId, status: \"unknown\" as const };\n"
    + "  }\n"
    + "  return { paymentId, status: \"refunded\" as const };\n"
    + "}\n",
};

async function lint(projectFiles: ProjectFile[], evaluator: Evaluator) {
  const changed = projectFiles.find(({ filePath }) => filePath === "src/refund.ts");
  const rule = defaultConfig.rules["jev/no-log-and-propagate"];
  expect(changed).toBeDefined();
  expect(rule).toBeDefined();
  if (!changed || !rule) return [];
  const config: JevLintConfig = { rules: { "jev/no-log-and-propagate": rule } };
  return analyzeFile({
    filePath: changed.filePath,
    source: changed.source,
    changedLines: [{ start: 1, end: changed.source.split("\n").length }],
    config,
    projectFiles,
  }, evaluator);
}

liveDescribe("log and propagate with structural evidence", () => {
  it("flags a catch that records and rethrows the same error", async () => {
    const smellyEvaluator = new RecordingEvaluator();
    const absorbingEvaluator = new RecordingEvaluator();
    const [smellyJudgments, absorbingJudgments] = await Promise.all([
      lint([SMELLY], smellyEvaluator),
      lint([ABSORBING], absorbingEvaluator),
    ]);

    expect(smellyEvaluator.probabilities.get("src/refund.ts")).toBeGreaterThanOrEqual(0.85);
    expect(smellyJudgments.some(({ probability }) => probability >= 0.85)).toBe(true);
    expect(absorbingJudgments).toEqual([]);
  });
});
