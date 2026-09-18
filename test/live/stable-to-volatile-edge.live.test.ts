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

const invoiceBefore = `export function total(items: number[]) {
  return items.length;
}
`;

const invoiceAfter = `import { tweak } from "./internal-helper.js";
export function total(items: number[]) {
  return tweak(items.length);
}
`;

const importer = (name: string) => `import { total } from "../billing/invoice.js";
export function ${name}() {
  return total([]);
}
`;

liveDescribe("stable to volatile edge live judgment", () => {
  it("scores a new edge from a fanned-in module into a volatile helper", async () => {
    const files = [
      projectFile("billing/invoice.ts", invoiceAfter),
      projectFile("billing/internal-helper.ts", "export function tweak(count: number) {\n  return count + 1;\n}\n"),
      projectFile("orders/cart.ts", importer("cart")),
      projectFile("shipping/label.ts", importer("label")),
      projectFile("invoicing/pay.ts", importer("pay")),
      ...Array.from({ length: 8 }, (_, index) => projectFile(`extra/widget-${index}.ts`)),
    ];
    const changes: SourceFile[] = [
      {
        filePath: "billing/invoice.ts",
        source: invoiceAfter,
        oldSource: invoiceBefore,
        changedLines: [{ start: 1, end: 1 }],
      },
      {
        filePath: "billing/internal-helper.ts",
        source: "export function tweak(count: number) {\n  return count + 1;\n}\n",
        oldSource: null,
        changedLines: [{ start: 1, end: 3 }],
      },
    ];

    const { judgments, probability } = await judge("jev/no-stable-to-volatile-edge", files, changes);

    expect(judgments.length).toBeGreaterThan(0);
    expect(judgments[0]?.ruleId).toBe("jev/no-stable-to-volatile-edge");
    expect(probability).toBeGreaterThanOrEqual(0);
    expect(probability).toBeLessThanOrEqual(1);
  });
});
