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
  readonly delegate = new TypeSafeEvaluator();
  evaluate(request: EvaluationRequest): Promise<Record<string, number>> {
    return this.delegate.evaluate(request);
  }
}

const beforeBarrel = `export { ShopCart } from "./cart.js";
`;

const afterWide = `export { ShopCart } from "./cart.js";
export * from "../billing.js";
export * from "./widgets/button.js";
`;

const afterCohesive = `export { ShopCart } from "./cart.js";
export { ShopTotal } from "./cart-total.js";
`;

const project: ProjectFile[] = [
  { filePath: "src/shop/cart.ts", source: "export function ShopCart() {\n  return {};\n}\n" },
  { filePath: "src/shop/cart-total.ts", source: "export function ShopTotal() {\n  return 0;\n}\n" },
  { filePath: "src/billing.ts", source: "export function invoice() {\n  return {};\n}\n" },
  {
    filePath: "src/shop/widgets/button.ts",
    source: "export function Button() {\n  return {};\n}\n",
  },
];

type Scenario = { changes: SourceFile[]; files: ProjectFile[] };

function scenario(after: string): Scenario {
  const changes: SourceFile[] = [{
    filePath: "src/shop/index.ts",
    source: after,
    oldSource: beforeBarrel,
    changedLines: [{ start: 2, end: 4 }],
  }];
  return { changes, files: [{ filePath: "src/shop/index.ts", source: after }, ...project] };
}

async function lint(changes: SourceFile[], files: ProjectFile[], evaluator: Evaluator) {
  const rule = defaultConfig.rules["jev/no-barrel-wide-reexport"];
  expect(rule).toBeDefined();
  if (!rule) return [];
  const config: JevLintConfig = { rules: { "jev/no-barrel-wide-reexport": rule } };
  return analyzeChanges({ changes, config, projectFiles: files }, evaluator);
}

liveDescribe("barrel wide reexport calibration", () => {
  it("flags a cross-domain wildcard barrel but keeps a cohesive sibling addition", async () => {
    const wide = scenario(afterWide);
    const cohesive = scenario(afterCohesive);
    const [wideJudgments, cohesiveJudgments] = await Promise.all([
      lint(wide.changes, wide.files, new PassthroughEvaluator()),
      lint(cohesive.changes, cohesive.files, new PassthroughEvaluator()),
    ]);

    expect(wideJudgments.map(({ ruleId }) => ruleId)).toContain("jev/no-barrel-wide-reexport");
    expect(cohesiveJudgments.every(({ probability }) => probability < 0.6)).toBe(true);
  });
});
