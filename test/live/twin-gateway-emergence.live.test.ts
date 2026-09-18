import { describe, expect, it } from "vitest";
import { analyzeModules } from "../../src/analyze.js";
import { defaultConfig } from "../../src/config.js";
import { TypeSafeEvaluator } from "../../src/typesafe-evaluator.js";
import type { EvaluationRequest, Evaluator, JevLintConfig, ProjectFile, SourceFile } from "../../src/types.js";

const liveDescribe = process.env.RUN_LIVE_JEV === "1" ? describe : describe.skip;

class RecordingEvaluator implements Evaluator {
  probability: number | undefined;
  readonly delegate = new TypeSafeEvaluator({ apiKey: process.env.TYPESAFE_API_KEY ?? "" });

  async evaluate(request: EvaluationRequest): Promise<Record<string, number>> {
    const answers = await this.delegate.evaluate(request);
    this.probability = answers.q0;
    return answers;
  }
}

function projectFile(filePath: string, source = "export const value = 1;\n"): ProjectFile {
  return { filePath, source };
}

async function judge(ruleId: string, files: ProjectFile[], changes: SourceFile[]) {
  const rule = defaultConfig.rules[ruleId];
  expect(rule).toBeDefined();
  if (!rule) return { judgments: [], probability: undefined };
  const config: JevLintConfig = { rules: { [ruleId]: rule } };
  const evaluator = new RecordingEvaluator();
  const judgments = await analyzeModules({ changes, config, projectFiles: files }, evaluator);
  return { judgments, probability: evaluator.probability };
}

const gateway = `import Stripe from "stripe";
export class Charge {
  constructor(readonly id: string) {}
}
const stripe = new Stripe("key");
export async function createCharge(amount: number) {
  const intent = await stripe.paymentIntents.create({ amount });
  return new Charge(intent.id);
}
`;

const labelsBefore = `export function label(orderId: string) {
  return orderId;
}
`;

const labelsAfter = `import Stripe from "stripe";
const stripe = new Stripe("key");
export async function label(orderId: string) {
  const intent = await stripe.paymentIntents.create({ amount: 100 });
  return intent.id + orderId;
}
`;

liveDescribe("twin gateway emergence live judgment", () => {
  it("scores a new direct wrap beside an established gateway", async () => {
    const files = [
      projectFile("billing/stripe-gateway.ts", gateway),
      projectFile(
        "billing/checkout.ts",
        "import { createCharge } from './stripe-gateway.js';\nexport async function checkout(amount: number) {\n  return createCharge(amount);\n}\n",
      ),
      projectFile(
        "billing/refund.ts",
        "import { Charge } from './stripe-gateway.js';\nexport function refund(charge: Charge) {\n  return charge.id;\n}\n",
      ),
      projectFile(
        "shipping/rates.ts",
        "import { createCharge } from '../billing/stripe-gateway.js';\nexport async function estimate(amount: number) {\n  return createCharge(amount);\n}\n",
      ),
      projectFile("shipping/labels.ts", labelsAfter),
      ...Array.from({ length: 8 }, (_, index) => projectFile(`extra/widget-${index}.ts`)),
    ];
    const changes: SourceFile[] = [{
      filePath: "shipping/labels.ts",
      source: labelsAfter,
      oldSource: labelsBefore,
      changedLines: [{ start: 1, end: 1 }],
    }];

    const { judgments, probability } = await judge("jev/no-twin-gateway-emergence", files, changes);

    expect(judgments).toHaveLength(1);
    expect(judgments[0]?.ruleId).toBe("jev/no-twin-gateway-emergence");
    expect(probability).toBeGreaterThanOrEqual(0);
    expect(probability).toBeLessThanOrEqual(1);
  });
});
