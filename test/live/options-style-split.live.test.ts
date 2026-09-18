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

const SPLIT = `export function fetchOrder(orderId: string): string {
  return orderId;
}
export function getOrder({ orderId }: { orderId: string }): string {
  return orderId;
}
export function shipOrder({ orderId, address }: { orderId: string; address: string }): string {
  return orderId + address;
}
`;

const UNIFORM_BEFORE = `export function fetchOrder(orderId: string): string {
  return orderId;
}
export function updateOrder(orderId: string, status: string): string {
  return orderId + status;
}
`;

const CALLER = `import { fetchOrder, getOrder, shipOrder } from "./shop.js";
export function lookup(orderId: string): string {
  return fetchOrder(orderId);
}
export function describe(orderId: string): string {
  return getOrder({ orderId });
}
export function dispatch(orderId: string, address: string): string {
  return shipOrder({ orderId, address });
}
export function shipById(orderId: string, address: string): string {
  return shipOrder({ orderId, address });
}
`;

function files(shopSource: string): ProjectFile[] {
  return [
    projectFile("features/shop/shop.ts", shopSource),
    projectFile("features/shop/cart.ts", CALLER),
    ...Array.from({ length: 9 }, (_, index) => projectFile(`features/extra/widget-${index}.ts`)),
  ];
}

function change(shopSource: string, oldSource: string | null): SourceFile[] {
  return [{
    filePath: "features/shop/shop.ts",
    source: shopSource,
    oldSource,
    changedLines: [{ start: 1, end: 6 }],
  }];
}

liveDescribe("options style split live judgment", () => {
  it("scores a module mixing options and positional exports above a uniform one", async () => {
    const { judgments, probability } = await judge(
      "jev/no-options-style-split",
      files(SPLIT),
      change(SPLIT, UNIFORM_BEFORE),
    );

    expect(judgments[0]?.ruleId).toBe("jev/no-options-style-split");
    expect(probability).toBeGreaterThanOrEqual(0.8);
    expect(judgments.some(({ probability }) => probability >= 0.8)).toBe(true);

    const uniformFiles = [
      projectFile("features/shop/shop.ts", UNIFORM_BEFORE),
      projectFile("features/shop/cart.ts", CALLER),
      ...Array.from({ length: 9 }, (_, index) => projectFile(`features/extra/widget-${index}.ts`)),
    ];
    const { judgments: uniformJudgments } = await judge(
      "jev/no-options-style-split",
      uniformFiles,
      change(UNIFORM_BEFORE, SPLIT),
    );
    expect(uniformJudgments.every(({ probability }) => probability < 0.5)).toBe(true);
  });
});
