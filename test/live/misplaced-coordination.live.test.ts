import { describe, expect, it } from "vitest";
import { analyzeFile } from "../../src/analyze.js";
import { defaultConfig } from "../../src/config.js";
import { TypeSafeEvaluator } from "../../src/typesafe-evaluator.js";
import type { EvaluationRequest, Evaluator, JevLintConfig, ProjectFile } from "../../src/types.js";

const liveDescribe = process.env.RUN_LIVE_JEV === "1" ? describe : describe.skip;
const ruleId = "jev/no-misplaced-coordination";

const paymentService: ProjectFile = {
  filePath: "src/payment-service.ts",
  source: `export async function chargeCard(id: string, total: number): Promise<void> {
  void id;
  void total;
}
`,
};

const orderRepository: ProjectFile = {
  filePath: "src/order-repository.ts",
  source: `export async function saveOrder(id: string): Promise<void> {
  void id;
}
`,
};

const mailer: ProjectFile = {
  filePath: "src/mailer.ts",
  source: `export async function sendEmail(kind: string): Promise<void> {
  void kind;
}
`,
};

const positive: ProjectFile[] = [
  {
    filePath: "src/order.ts",
    source: `import { chargeCard } from "./payment-service.js";
import { saveOrder } from "./order-repository.js";
import { sendEmail } from "./mailer.js";

export class Order {
  constructor(private id: string, private total: number) {}

  async place(): Promise<void> {
    await chargeCard(this.id, this.total);
    await saveOrder(this.id);
    await sendEmail("receipt");
  }
}
`,
  },
  paymentService,
  orderRepository,
  mailer,
];

const negative: ProjectFile[] = [
  {
    filePath: "src/order-service.ts",
    source: `import { chargeCard } from "./payment-service.js";
import { saveOrder } from "./order-repository.js";
import { sendEmail } from "./mailer.js";
import type { Order } from "./order.js";

export class OrderService {
  async placeOrder(order: Order): Promise<void> {
    await chargeCard(order.id, order.total);
    await saveOrder(order.id);
    await sendEmail("receipt");
  }
}
`,
  },
  paymentService,
  orderRepository,
  mailer,
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

liveDescribe("misplaced coordination calibration", () => {
  it("scores entity-side coordination above the service-home equivalent", async () => {
    const [misplaced, placed] = await Promise.all([calibrate(positive), calibrate(negative)]);

    if (misplaced.probability === undefined || placed.probability === undefined) {
      throw new Error("live calibration produced no probability");
    }
    expect(misplaced.probability).toBeGreaterThan(placed.probability);
    expect(misplaced.judgments.map(({ ruleId: id }) => id)).toEqual([ruleId]);
  });
});
