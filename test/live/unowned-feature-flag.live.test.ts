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

const before = `export function checkoutTotal(cart: Cart) {
  return renderLegacy(cart);
}
`;

const afterBare = `import { flags } from "./flags";
export function checkoutTotal(cart: Cart) {
  if (flags.newCheckout) {
    return renderNew(cart);
  }
  return renderLegacy(cart);
}
`;

const afterTicketed = `import { flags } from "./flags";
// owner: checkout-team, ticket: PROJ-123, removeAfter: 2026-12-01
export function checkoutTotal(cart: Cart) {
  if (flags.newCheckout) {
    return renderNew(cart);
  }
  return renderLegacy(cart);
}
`;

const siblingDisciplined: ProjectFile = {
  filePath: "src/search.ts",
  source: `import { flags } from "./flags";
// ticket: PROJ-99, owner: search-team
export function search(query: string) {
  if (flags.newSearch) {
    return searchV2(query);
  }
  return searchV1(query);
}
`,
};

type ChangeScenario = {
  changes: SourceFile[];
  project: ProjectFile[];
};

function scenario(after: string): ChangeScenario {
  const changes: SourceFile[] = [{
    filePath: "src/checkout.ts",
    source: after,
    oldSource: before,
    changedLines: [{ start: 1, end: 8 }],
  }];
  const project: ProjectFile[] = [
    { filePath: "src/checkout.ts", source: after },
    siblingDisciplined,
  ];
  return { changes, project };
}

async function lint(changes: SourceFile[], project: ProjectFile[], evaluator: Evaluator) {
  const rule = defaultConfig.rules["jev/no-unowned-feature-flag"];
  expect(rule).toBeDefined();
  if (!rule) return [];
  const config: JevLintConfig = { rules: { "jev/no-unowned-feature-flag": rule } };
  return analyzeChanges({ changes, config, projectFiles: project }, evaluator);
}

liveDescribe("unowned feature flag calibration", () => {
  it("flags a bare newborn gate but keeps a ticketed one", async () => {
    const bare = scenario(afterBare);
    const ticketed = scenario(afterTicketed);
    const [bareJudgments, ticketedJudgments] = await Promise.all([
      lint(bare.changes, bare.project, new PassthroughEvaluator()),
      lint(ticketed.changes, ticketed.project, new PassthroughEvaluator()),
    ]);

    expect(bareJudgments.map(({ ruleId }) => ruleId)).toContain("jev/no-unowned-feature-flag");
    expect(ticketedJudgments.every(({ probability }) => probability < 0.6)).toBe(true);
  });
});
