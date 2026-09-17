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

const pricingBefore = `export function calculateTotal(items: number[]) {
  return items.reduce((total, item) => total + item, 0);
}
`;

const pricingAfter = `export function calculateTotal(items: number[]) {
  return items.reduce((total, item) => total + item, 0);
}
export interface Invoice {
  id: string;
  total: number;
}
`;

function importer(area: string, name: string): ProjectFile {
  return projectFile(
    `${area}/${name}.ts`,
    `import { calculateTotal } from "../billing/pricing.js";\nexport const total = calculateTotal([1]);\n`,
  );
}

liveDescribe("stable surface widening live judgment", () => {
  it("scores additive exports on a widely-consumed module", async () => {
    const files = [
      projectFile("billing/pricing.ts", pricingAfter),
      projectFile("billing/index.ts", `export { calculateTotal } from "./pricing.js";\n`),
      importer("orders", "cart"),
      importer("shipping", "ship"),
      importer("invoicing", "pay"),
      ...Array.from({ length: 6 }, (_, index) => projectFile(`extra/widget-${index}.ts`)),
    ];
    const changes: SourceFile[] = [{
      filePath: "billing/pricing.ts",
      source: pricingAfter,
      oldSource: pricingBefore,
      changedLines: [{ start: 4, end: 7 }],
    }];

    const { judgments, probability } = await judge("jev/no-stable-surface-widening", files, changes);

    expect(judgments).toHaveLength(1);
    expect(judgments[0]?.ruleId).toBe("jev/no-stable-surface-widening");
    expect(probability).toBeGreaterThanOrEqual(0);
    expect(probability).toBeLessThanOrEqual(1);
  });
});
