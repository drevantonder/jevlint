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

const cartBefore = `export function add(item: string) {
  return item;
}
`;

const cartAfter = `import { cartState } from "../billing/store.js";
export function add(item: string) {
  cartState.items.push(item);
  return cartState.items.length;
}
`;

liveDescribe("new foreign state write edge live judgment", () => {
  it("scores a first write across a new module edge", async () => {
    const files = [
      projectFile(
        "billing/store.ts",
        "export let cartState = { items: [] as string[] };\nexport function setCart(items: string[]) {\n  cartState = { items };\n}\n",
      ),
      projectFile("orders/cart.ts", cartAfter),
      ...Array.from({ length: 9 }, (_, index) => projectFile(`extra/widget-${index}.ts`)),
    ];
    const changes: SourceFile[] = [{
      filePath: "orders/cart.ts",
      source: cartAfter,
      oldSource: cartBefore,
      changedLines: [{ start: 1, end: 5 }],
    }];

    const { judgments, probability } = await judge("jev/no-new-foreign-state-write-edge", files, changes);

    expect(judgments).toHaveLength(1);
    expect(judgments[0]?.ruleId).toBe("jev/no-new-foreign-state-write-edge");
    expect(probability).toBeGreaterThanOrEqual(0);
    expect(probability).toBeLessThanOrEqual(1);
  });
});
