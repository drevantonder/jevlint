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

const billingBefore = `export function createInvoice(id: string) {
  return id;
}
`;

const billingAfter = `export function createInvoice(id: string) {
  return id;
}
export function chargeCard(id: string) {
  return id;
}
`;

const shippingStore = `export function createShipment(id: string) {
  return id;
}
export function trackParcel(id: string) {
  return id;
}
`;

liveDescribe("same stem divergent role live judgment", () => {
  it("scores a same-stem twin with disjoint exports", async () => {
    const files = [
      projectFile("billing/store.ts", billingAfter),
      projectFile("billing/helper.ts", `export function help() {\n  return 1;\n}\n`),
      projectFile("shipping/store.ts", shippingStore),
      projectFile("shipping/helper.ts", `export function help() {\n  return 2;\n}\n`),
      projectFile(
        "orders/checkout.ts",
        `import { createInvoice } from "../billing/store.js";\nimport { createShipment } from "../shipping/store.js";\nexport function checkout(id: string) {\n  return createInvoice(id) + createShipment(id);\n}\n`,
      ),
      ...Array.from({ length: 7 }, (_, index) => projectFile(`extra/widget-${index}.ts`)),
    ];
    const changes: SourceFile[] = [{
      filePath: "billing/store.ts",
      source: billingAfter,
      oldSource: billingBefore,
      changedLines: [{ start: 4, end: 6 }],
    }];

    const { judgments, probability } = await judge("jev/no-same-stem-divergent-role", files, changes);

    expect(judgments).toHaveLength(1);
    expect(judgments[0]?.ruleId).toBe("jev/no-same-stem-divergent-role");
    expect(probability).toBeGreaterThanOrEqual(0);
    expect(probability).toBeLessThanOrEqual(1);
  });
});
