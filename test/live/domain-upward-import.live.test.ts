import { describe, expect, it } from "vitest";
import { analyzeFile } from "../../src/analyze.js";
import { defaultConfig } from "../../src/config.js";
import { TypeSafeEvaluator } from "../../src/typesafe-evaluator.js";
import type { EvaluationRequest, Evaluator, JevLintConfig, ProjectFile } from "../../src/types.js";

const liveDescribe = process.env.RUN_LIVE_JEV === "1" ? describe : describe.skip;

class PassthroughEvaluator implements Evaluator {
  readonly delegate = new TypeSafeEvaluator({ apiKey: process.env.JEVLINT_TYPESAFE_API_KEY ?? "" });
  evaluate(request: EvaluationRequest): Promise<Record<string, number>> {
    return this.delegate.evaluate(request);
  }
}

const upwardPricing = `import { stripe } from "../adapters/stripe-client.js";
export function price(order: Order) {
  return stripe.quote(order);
}
`;

const kernelPricing = `import { Money } from "../shared/money.js";
export function price(order: Order) {
  return Money.zero();
}
`;

const stripeClient: ProjectFile = {
  filePath: "src/adapters/stripe-client.ts",
  source: `export const stripe = {
  quote(order: unknown) {
    return order;
  },
};
`,
};

const money: ProjectFile = {
  filePath: "src/shared/money.ts",
  source: `export const Money = {
  zero() {
    return 0;
  },
};
`,
};

async function lint(source: string, filePath: string, project: ProjectFile[], evaluator: Evaluator) {
  const rule = defaultConfig.rules["jev/no-domain-upward-import"];
  expect(rule).toBeDefined();
  if (!rule) return [];
  const config: JevLintConfig = { rules: { "jev/no-domain-upward-import": rule } };
  return analyzeFile({
    filePath,
    source,
    changedLines: [{ start: 1, end: source.split("\n").length }],
    config,
    projectFiles: project,
  }, evaluator);
}

liveDescribe("domain upward import calibration", () => {
  it("flags a domain function importing an adapter but keeps a shared-kernel import", async () => {
    const [upwardJudgments, kernelJudgments] = await Promise.all([
      lint(upwardPricing, "src/domain/pricing.ts", [
        { filePath: "src/domain/pricing.ts", source: upwardPricing },
        stripeClient,
      ], new PassthroughEvaluator()),
      lint(kernelPricing, "src/domain/pricing.ts", [
        { filePath: "src/domain/pricing.ts", source: kernelPricing },
        money,
      ], new PassthroughEvaluator()),
    ]);

    expect(upwardJudgments.map(({ ruleId }) => ruleId)).toContain("jev/no-domain-upward-import");
    expect(kernelJudgments.every(({ probability }) => probability < 0.6)).toBe(true);
  });
});
