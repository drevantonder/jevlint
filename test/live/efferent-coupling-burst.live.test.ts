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

const cartBefore = `import { total } from "../billing/invoice.js";
export function cart() {
  return total([]);
}
`;

const cartAfter = `import { total } from "../billing/invoice.js";
import { label } from "../shipping/label.js";
import { method } from "../payments/method.js";
export function cart() {
  return [total([]), label(), method()].join(",");
}
`;

liveDescribe("efferent coupling burst live judgment", () => {
  it("scores added edges into new areas", async () => {
    const files = [
      projectFile("billing/invoice.ts", "export function total(items: unknown[]) {\n  return items.length;\n}\n"),
      projectFile("shipping/label.ts", "export function label() {\n  return \"label\";\n}\n"),
      projectFile("payments/method.ts", "export function method() {\n  return \"card\";\n}\n"),
      projectFile("orders/cart.ts", cartAfter),
      ...Array.from({ length: 8 }, (_, index) => projectFile(`extra/widget-${index}.ts`)),
    ];
    const changes: SourceFile[] = [{
      filePath: "orders/cart.ts",
      source: cartAfter,
      oldSource: cartBefore,
      changedLines: [{ start: 1, end: 3 }],
    }];

    const { judgments, probability } = await judge("jev/no-efferent-coupling-burst", files, changes);

    expect(judgments).toHaveLength(1);
    expect(judgments[0]?.ruleId).toBe("jev/no-efferent-coupling-burst");
    expect(probability).toBeGreaterThanOrEqual(0);
    expect(probability).toBeLessThanOrEqual(1);
  });
});
