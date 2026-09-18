import { describe, expect, it } from "vitest";
import { analyzeModules } from "../../src/analyze.js";
import { defaultConfig } from "../../src/config.js";
import { TypeSafeEvaluator } from "../../src/typesafe-evaluator.js";
import type { EvaluationRequest, Evaluator, JevLintConfig, ProjectFile, SourceFile } from "../../src/types.js";

const liveDescribe = process.env.RUN_LIVE_JEV === "1" ? describe : describe.skip;

class RecordingEvaluator implements Evaluator {
  probability: number | undefined;
  readonly delegate = new TypeSafeEvaluator({ apiKey: process.env.JEVLINT_TYPESAFE_API_KEY ?? "" });

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

const invoiceBefore = `export function total(items: number[]) {
  return items.length;
}
export function refund(id: string) {
  return id;
}
`;

const invoiceAfter = `export function total(items: number[]) {
  return items.length;
}
`;

const importer = (name: string) => `import { refund } from "../billing/invoice.js";
export function ${name}() {
  return refund("x");
}
`;

liveDescribe("cross-area export break live judgment", () => {
  it("scores a removed export against its cross-area importers", async () => {
    const files = [
      projectFile("billing/invoice.ts", invoiceAfter),
      projectFile("orders/cart.ts", importer("cart")),
      projectFile("shipping/label.ts", importer("label")),
      projectFile("invoicing/pay.ts", importer("pay")),
      ...Array.from({ length: 8 }, (_, index) => projectFile(`extra/widget-${index}.ts`)),
    ];
    const changes: SourceFile[] = [{
      filePath: "billing/invoice.ts",
      source: invoiceAfter,
      oldSource: invoiceBefore,
      changedLines: [{ start: 1, end: 6 }],
    }];

    const { judgments, probability } = await judge("jev/no-cross-area-export-break", files, changes);

    expect(judgments).toHaveLength(1);
    expect(judgments[0]?.ruleId).toBe("jev/no-cross-area-export-break");
    expect(probability).toBeGreaterThanOrEqual(0);
    expect(probability).toBeLessThanOrEqual(1);
  });
});
