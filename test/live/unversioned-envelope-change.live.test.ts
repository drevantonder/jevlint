import { describe, expect, it } from "vitest";
import { analyzeChanges } from "../../src/analyze.js";
import { defaultConfig } from "../../src/config.js";
import { TypeSafeEvaluator } from "../../src/typesafe-evaluator.js";
import type {
  Evaluator,
  JevLintConfig,
  ProjectFile,
  SourceFile,
} from "../../src/types.js";

const liveDescribe = process.env.RUN_LIVE_JEV === "1" ? describe : describe.skip;

class PassthroughEvaluator implements Evaluator {
  readonly delegate = new TypeSafeEvaluator({ apiKey: process.env.JEVLINT_TYPESAFE_API_KEY ?? "" });
  evaluate(request: Parameters<Evaluator["evaluate"]>[0]) {
    return this.delegate.evaluate(request);
  }
}

const before = `export interface OrderEvent {
  orderId: string;
  total: number;
}
`;

const afterBreaking = `export interface OrderEvent {
  orderId: string;
  total: number;
  currency: string;
}
`;

const afterCompatible = `export interface OrderEvent {
  orderId: string;
  total: number;
  couponCode?: string;
}
`;

const consumer = `import type { OrderEvent } from "./order-event";
export function summarize(event: OrderEvent): string {
  return event.orderId;
}
`;

type ChangeScenario = {
  changes: SourceFile[];
  project: ProjectFile[];
};

function scenario(after: string): ChangeScenario {
  const changes: SourceFile[] = [{
    filePath: "src/order-event.ts",
    source: after,
    oldSource: before,
    changedLines: [{ start: 1, end: 5 }],
  }];
  const project: ProjectFile[] = [
    { filePath: "src/order-event.ts", source: after },
    { filePath: "src/checkout.ts", source: consumer },
  ];
  return { changes, project };
}

async function lint(changes: SourceFile[], project: ProjectFile[], evaluator: Evaluator) {
  const rule = defaultConfig.rules["jev/no-unversioned-envelope-change"];
  expect(rule).toBeDefined();
  if (!rule) return [];
  const config: JevLintConfig = { rules: { "jev/no-unversioned-envelope-change": rule } };
  return analyzeChanges({ changes, config, projectFiles: project }, evaluator);
}

liveDescribe("unversioned envelope change calibration", () => {
  it("flags a required addition but keeps an optional one", async () => {
    const breaking = scenario(afterBreaking);
    const compatible = scenario(afterCompatible);
    const [breakingJudgments, compatibleJudgments] = await Promise.all([
      lint(breaking.changes, breaking.project, new PassthroughEvaluator()),
      lint(compatible.changes, compatible.project, new PassthroughEvaluator()),
    ]);

    expect(breakingJudgments.map(({ ruleId }) => ruleId)).toContain(
      "jev/no-unversioned-envelope-change",
    );
    expect(compatibleJudgments.every(({ probability }) => probability < 0.6)).toBe(true);
  });
});