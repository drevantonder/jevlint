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

const before = `export const storeName = "session";
`;

const afterMutable = `export const storeName = "session";
export let currentUser: string | null = null;
`;

const afterFrozen = `export const storeName = "session";
export const defaultUser = "anon";
`;

type ChangeScenario = {
  changes: SourceFile[];
  project: ProjectFile[];
};

function scenario(after: string): ChangeScenario {
  const changes: SourceFile[] = [{
    filePath: "src/store.ts",
    source: after,
    oldSource: before,
    changedLines: [{ start: 1, end: 3 }],
  }];
  const project: ProjectFile[] = [{ filePath: "src/store.ts", source: after }];
  return { changes, project };
}

async function lint(changes: SourceFile[], project: ProjectFile[], evaluator: Evaluator) {
  const rule = defaultConfig.rules["jev/no-mutable-surface-expansion"];
  expect(rule).toBeDefined();
  if (!rule) return [];
  const config: JevLintConfig = { rules: { "jev/no-mutable-surface-expansion": rule } };
  return analyzeChanges({ changes, config, projectFiles: project }, evaluator);
}

liveDescribe("mutable surface expansion calibration", () => {
  it("flags an exported let but keeps a frozen export low", async () => {
    const mutable = scenario(afterMutable);
    const frozen = scenario(afterFrozen);
    const [mutableJudgments, frozenJudgments] = await Promise.all([
      lint(mutable.changes, mutable.project, new PassthroughEvaluator()),
      lint(frozen.changes, frozen.project, new PassthroughEvaluator()),
    ]);

    expect(mutableJudgments.map(({ ruleId }) => ruleId)).toContain(
      "jev/no-mutable-surface-expansion",
    );
    expect(frozenJudgments.every(({ probability }) => probability < 0.6)).toBe(true);
  });
});
