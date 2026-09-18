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

type ChangeScenario = {
  changes: SourceFile[];
  project: ProjectFile[];
};

class PassthroughEvaluator implements Evaluator {
  readonly delegate = new TypeSafeEvaluator({ apiKey: process.env.TYPESAFE_API_KEY ?? "" });
  evaluate(request: EvaluationRequest): Promise<Record<string, number>> {
    return this.delegate.evaluate(request);
  }
}

const before = `export function getUser(id: string) {
  return { id };
}
`;

const afterBreaking = `export function getUser(id: string, tenant: string) {
  return { id, tenant };
}
`;

const afterCompatible = `export function getUser(id: string, tenant = "default") {
  return { id, tenant };
}
`;

const caller = `import { getUser } from "./api";
export function handle(id: string) {
  return getUser(id);
}
`;

function scenario(after: string): ChangeScenario {
  const changes: SourceFile[] = [{
    filePath: "src/api.ts",
    source: after,
    oldSource: before,
    changedLines: [{ start: 1, end: 3 }],
  }];
  const project: ProjectFile[] = [
    { filePath: "src/api.ts", source: after },
    { filePath: "src/handler.ts", source: caller },
  ];
  return { changes, project };
}

async function lint(changes: SourceFile[], project: ProjectFile[], evaluator: Evaluator) {
  const rule = defaultConfig.rules["jev/no-breaking-export-reshape"];
  expect(rule).toBeDefined();
  if (!rule) return [];
  const config: JevLintConfig = { rules: { "jev/no-breaking-export-reshape": rule } };
  return analyzeChanges({ changes, config, projectFiles: project }, evaluator);
}

liveDescribe("breaking export reshape calibration", () => {
  it("flags a required parameter without a shim but keeps a defaulted one", async () => {
    const breaking = scenario(afterBreaking);
    const compatible = scenario(afterCompatible);
    const [breakingJudgments, compatibleJudgments] = await Promise.all([
      lint(breaking.changes, breaking.project, new PassthroughEvaluator()),
      lint(compatible.changes, compatible.project, new PassthroughEvaluator()),
    ]);

    expect(breakingJudgments.map(({ ruleId }) => ruleId)).toContain(
      "jev/no-breaking-export-reshape",
    );
    expect(compatibleJudgments.every(({ probability }) => probability < 0.6)).toBe(true);
  });
});
