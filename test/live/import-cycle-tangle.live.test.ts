import { describe, expect, it } from "vitest";
import { analyzeChanges } from "../../src/analyze.js";
import { defaultConfig } from "../../src/config.js";
import { TypeSafeEvaluator } from "../../src/typesafe-evaluator.js";
import type {
  EvaluationRequest,
  Evaluator,
  JevLintConfig,
  ProjectFile,
  SourceFile,
} from "../../src/types.js";

const liveDescribe = process.env.RUN_LIVE_JEV === "1" ? describe : describe.skip;

class PassthroughEvaluator implements Evaluator {
  readonly delegate = new TypeSafeEvaluator({ apiKey: process.env.TYPESAFE_API_KEY ?? "" });
  evaluate(request: EvaluationRequest): Promise<Record<string, number>> {
    return this.delegate.evaluate(request);
  }
}

const beforeOrder = `export function placeOrder() {
  return "pending";
}
`;

const afterCycle = `import { charge } from "../adapters/stripe.js";
export function placeOrder() {
  return charge();
}
`;

const afterClean = `import { Money } from "../shared/money.js";
export function placeOrder() {
  return Money.zero();
}
`;

const stripe = `import { placeOrder } from "../domain/order.js";
export function charge() {
  return placeOrder();
}
`;

const money = `export const Money = {
  zero() {
    return 0;
  },
};
`;

type Scenario = { changes: SourceFile[]; project: ProjectFile[] };

function scenario(after: string, extra: ProjectFile): Scenario {
  const changes: SourceFile[] = [{
    filePath: "src/domain/order.ts",
    source: after,
    oldSource: beforeOrder,
    changedLines: [{ start: 1, end: 4 }],
  }];
  const project: ProjectFile[] = [
    { filePath: "src/domain/order.ts", source: after },
    extra,
  ];
  return { changes, project };
}

async function lint(changes: SourceFile[], project: ProjectFile[], evaluator: Evaluator) {
  const rule = defaultConfig.rules["jev/no-import-cycle-tangle"];
  expect(rule).toBeDefined();
  if (!rule) return [];
  const config: JevLintConfig = { rules: { "jev/no-import-cycle-tangle": rule } };
  return analyzeChanges({ changes, config, projectFiles: project }, evaluator);
}

liveDescribe("import cycle tangle calibration", () => {
  it("flags a value-import cycle across layers but keeps a shared-kernel import", async () => {
    const tangled = scenario(afterCycle, { filePath: "src/adapters/stripe.ts", source: stripe });
    const clean = scenario(afterClean, { filePath: "src/shared/money.ts", source: money });
    const [tangledJudgments, cleanJudgments] = await Promise.all([
      lint(tangled.changes, tangled.project, new PassthroughEvaluator()),
      lint(clean.changes, clean.project, new PassthroughEvaluator()),
    ]);

    expect(tangledJudgments.map(({ ruleId }) => ruleId)).toContain("jev/no-import-cycle-tangle");
    expect(cleanJudgments.every(({ probability }) => probability < 0.6)).toBe(true);
  });
});
