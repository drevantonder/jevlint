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

const calc = `export function calculateTotal(items: number[]) {
  return items.reduce((total, item) => total + item, 0);
}
`;

const barrel = `export { calculateTotal } from "./calc.js";
export { formatMoney } from "./format.js";
`;

const payBefore = `import { calculateTotal } from "../billing/index.js";
export function pay(items: number[]) {
  return calculateTotal(items);
}
`;

const payAfter = `import { calculateTotal } from "../billing/calc.js";
export function pay(items: number[]) {
  return calculateTotal(items);
}
`;

const viaBarrel = `import { calculateTotal } from "../billing/index.js";
export function ship(items: number[]) {
  return calculateTotal(items);
}
`;

liveDescribe("barrel bypass live judgment", () => {
  it("scores a new deep import against the feature barrel", async () => {
    const files = [
      projectFile("features/billing/calc.ts", calc),
      projectFile(
        "features/billing/format.ts",
        "export function formatMoney(amount: number) {\n  return String(amount);\n}\n",
      ),
      projectFile("features/billing/index.ts", barrel),
      projectFile("features/invoicing/pay.ts", payAfter),
      projectFile("features/shipping/ship.ts", viaBarrel),
      projectFile("features/orders/cart.ts", viaBarrel.replace("ship", "cart")),
      ...Array.from({ length: 8 }, (_, index) => projectFile(`features/extra/widget-${index}.ts`)),
    ];
    const changes: SourceFile[] = [{
      filePath: "features/invoicing/pay.ts",
      source: payAfter,
      oldSource: payBefore,
      changedLines: [{ start: 1, end: 1 }],
    }];

    const { judgments, probability } = await judge("jev/no-barrel-bypass", files, changes);

    expect(judgments).toHaveLength(1);
    expect(judgments[0]?.ruleId).toBe("jev/no-barrel-bypass");
    expect(probability).toBeGreaterThanOrEqual(0);
    expect(probability).toBeLessThanOrEqual(1);
  });
});
