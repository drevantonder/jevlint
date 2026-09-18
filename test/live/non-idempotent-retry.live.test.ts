import { describe, expect, it } from "vitest";
import { analyzeFile } from "../../src/analyze.js";
import { defaultConfig } from "../../src/config.js";
import { TypeSafeEvaluator } from "../../src/typesafe-evaluator.js";
import type { EvaluationRequest, Evaluator, JevLintConfig, ProjectFile } from "../../src/types.js";

const liveDescribe = process.env.RUN_LIVE_JEV === "1" ? describe : describe.skip;
const ruleId = "jev/no-non-idempotent-retry";

const positive: ProjectFile[] = [
  {
    filePath: "src/checkout.ts",
    source: `export async function checkout(order: Order) {
  return withRetry(() => payments.charge(order), { attempts: 3 });
}
`,
  },
];

const negative: ProjectFile[] = [
  {
    filePath: "src/checkout.ts",
    source: `export async function checkout(order: Order) {
  return withRetry(() => payments.charge({ ...order, idempotencyKey: order.id }), { attempts: 3 });
}
`,
  },
];

class RecordingEvaluator implements Evaluator {
  probability: number | undefined;
  readonly delegate = new TypeSafeEvaluator({ apiKey: process.env.TYPESAFE_API_KEY ?? "" });

  async evaluate(request: EvaluationRequest): Promise<Record<string, number>> {
    const answers = await this.delegate.evaluate(request);
    this.probability = answers.q0;
    return answers;
  }
}

async function calibrate(projectFiles: ProjectFile[]) {
  const changed = projectFiles[0];
  const rule = defaultConfig.rules[ruleId];
  expect(changed).toBeDefined();
  expect(rule).toBeDefined();
  if (!changed || !rule) return { judgments: [], probability: undefined };
  const config: JevLintConfig = { rules: { [ruleId]: rule } };
  const evaluator = new RecordingEvaluator();
  const judgments = await analyzeFile({
    filePath: changed.filePath,
    source: changed.source,
    changedLines: [{ start: 1, end: changed.source.split("\n").length }],
    config,
    projectFiles,
  }, evaluator);
  return { judgments, probability: evaluator.probability };
}

liveDescribe("non-idempotent retry calibration", () => {
  it("scores the keyless retry above the keyed one", async () => {
    const [keyless, keyed] = await Promise.all([calibrate(positive), calibrate(negative)]);

    if (keyless.probability === undefined || keyed.probability === undefined) {
      throw new Error("live calibration produced no probability");
    }
    expect(keyless.probability).toBeGreaterThan(keyed.probability);
    expect(keyless.judgments.map(({ ruleId: id }) => id)).toEqual([ruleId]);
  });
});
