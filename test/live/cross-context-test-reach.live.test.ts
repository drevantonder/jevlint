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

const shipBefore = `export function ship(id: string) {
  return id;
}
`;

const shipAfter = `import { orderFixture } from "../billing/fixtures/orders.js";
export function ship(id: string) {
  const order = orderFixture();
  return order.id + id;
}
`;

liveDescribe("cross context test reach live judgment", () => {
  it("scores a new runtime edge into another area's fixtures", async () => {
    const files = [
      projectFile(
        "billing/fixtures/orders.ts",
        "export function orderFixture() {\n  return { id: 'order-1' };\n}\n",
      ),
      projectFile("shipping/ship.ts", shipAfter),
      projectFile(
        "orders/cart.ts",
        "import { orderFixture } from '../billing/fixtures/orders.js';\nexport function cart() {\n  return orderFixture().id;\n}\n",
      ),
      ...Array.from({ length: 8 }, (_, index) => projectFile(`extra/widget-${index}.ts`)),
    ];
    const changes: SourceFile[] = [{
      filePath: "shipping/ship.ts",
      source: shipAfter,
      oldSource: shipBefore,
      changedLines: [{ start: 1, end: 1 }],
    }];

    const { judgments, probability } = await judge("jev/no-cross-context-test-reach", files, changes);

    expect(judgments).toHaveLength(1);
    expect(judgments[0]?.ruleId).toBe("jev/no-cross-context-test-reach");
    expect(probability).toBeGreaterThanOrEqual(0);
    expect(probability).toBeLessThanOrEqual(1);
  });
});
