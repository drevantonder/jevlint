import { describe, expect, it } from "vitest";
import { analyzeModules } from "../../src/analyze.js";
import { defaultConfig } from "../../src/config.js";
import { TypeSafeEvaluator } from "../../src/typesafe-evaluator.js";
import type { EvaluationRequest, Evaluator, JevLintConfig, ProjectFile, SourceFile } from "../../src/types.js";

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

const kernel = `export class Order {
  constructor(readonly id: string) {}
}
export class Customer {
  constructor(readonly name: string) {}
}
`;

const billingConsumer = `import { Order } from "../shared/kernel.js";
export function bill(order: Order) {
  return order.id;
}
`;

const shippingConsumer = `import { Customer } from "../shared/kernel.js";
export function shipTo(customer: Customer) {
  return customer.name;
}
`;

const ordersConsumer = `import { Order } from "../shared/kernel.js";
export function archive(order: Order) {
  return order.id;
}
`;

const payBefore = `export function pay(amount: number) {
  return amount;
}
`;

const payAfter = `import { Order } from "../shared/kernel.js";
export function pay(order: Order) {
  return order.id;
}
`;

liveDescribe("shared kernel new consumer live judgment", () => {
  it("scores a new edge from a fresh area into the shared kernel", async () => {
    const files = [
      projectFile("shared/kernel.ts", kernel),
      projectFile("billing/invoice.ts", billingConsumer),
      projectFile("shipping/label.ts", shippingConsumer),
      projectFile("orders/history.ts", ordersConsumer),
      projectFile("invoicing/pay.ts", payAfter),
      ...Array.from({ length: 6 }, (_, index) => projectFile(`extra/widget-${index}.ts`)),
    ];
    const changes: SourceFile[] = [{
      filePath: "invoicing/pay.ts",
      source: payAfter,
      oldSource: payBefore,
      changedLines: [{ start: 1, end: 1 }],
    }];

    const { judgments, probability } = await judge("jev/no-shared-kernel-new-consumer", files, changes);

    expect(judgments).toHaveLength(1);
    expect(judgments[0]?.ruleId).toBe("jev/no-shared-kernel-new-consumer");
    expect(probability).toBeGreaterThanOrEqual(0);
    expect(probability).toBeLessThanOrEqual(1);
  });
});
