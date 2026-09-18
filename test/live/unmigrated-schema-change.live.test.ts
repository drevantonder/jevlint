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
  readonly delegate = new TypeSafeEvaluator({ apiKey: process.env.JEVLINT_TYPESAFE_API_KEY ?? "" });
  evaluate(request: EvaluationRequest): Promise<Record<string, number>> {
    return this.delegate.evaluate(request);
  }
}

const before = `export interface Customer {
  id: string;
  name?: string;
}
`;

const afterTightened = `export interface Customer {
  id: string;
  name?: string;
  email: string;
}
`;

const afterNullable = `export interface Customer {
  id: string;
  name?: string;
  email?: string;
}
`;

const migrationPrecedent: ProjectFile = {
  filePath: "migrations/003-backfill.sql",
  source: `UPDATE customers SET name = '' WHERE name IS NULL;`,
};

type ChangeScenario = {
  changes: SourceFile[];
  project: ProjectFile[];
};

function scenario(after: string): ChangeScenario {
  const changes: SourceFile[] = [{
    filePath: "src/models/customer.ts",
    source: after,
    oldSource: before,
    changedLines: [{ start: 1, end: 5 }],
  }];
  const project: ProjectFile[] = [
    { filePath: "src/models/customer.ts", source: after },
    migrationPrecedent,
  ];
  return { changes, project };
}

async function lint(changes: SourceFile[], project: ProjectFile[], evaluator: Evaluator) {
  const rule = defaultConfig.rules["jev/no-unmigrated-schema-change"];
  expect(rule).toBeDefined();
  if (!rule) return [];
  const config: JevLintConfig = { rules: { "jev/no-unmigrated-schema-change": rule } };
  return analyzeChanges({ changes, config, projectFiles: project }, evaluator);
}

liveDescribe("unmigrated schema change calibration", () => {
  it("flags a required field without a migration but keeps a nullable one", async () => {
    const tightened = scenario(afterTightened);
    const nullable = scenario(afterNullable);
    const [tightenedJudgments, nullableJudgments] = await Promise.all([
      lint(tightened.changes, tightened.project, new PassthroughEvaluator()),
      lint(nullable.changes, nullable.project, new PassthroughEvaluator()),
    ]);

    expect(tightenedJudgments.map(({ ruleId }) => ruleId)).toContain(
      "jev/no-unmigrated-schema-change",
    );
    expect(nullableJudgments.every(({ probability }) => probability < 0.6)).toBe(true);
  });
});
