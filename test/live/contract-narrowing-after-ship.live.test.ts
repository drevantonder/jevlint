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

const before = `export type ListOptions = {
  limit?: number;
};
export function listUsers(options: ListOptions): string[] {
  return [];
}
`;

const afterNarrowed = `export type ListOptions = {
  limit?: number;
  tenant: string;
};
export function listUsers(options: ListOptions): string[] {
  return [];
}
`;

const afterOptional = `export type ListOptions = {
  limit?: number;
  tenant?: string;
};
export function listUsers(options: ListOptions): string[] {
  return [];
}
`;

const caller: ProjectFile = {
  filePath: "src/handler.ts",
  source: "import { listUsers } from \"./api\";\n"
    + "export function handle(): string[] {\n"
    + "  return listUsers({});\n"
    + "}\n",
};

type ChangeScenario = {
  changes: SourceFile[];
  project: ProjectFile[];
};

function scenario(after: string): ChangeScenario {
  const changes: SourceFile[] = [{
    filePath: "src/api.ts",
    source: after,
    oldSource: before,
    changedLines: [{ start: 1, end: 7 }],
  }];
  const project: ProjectFile[] = [
    { filePath: "src/api.ts", source: after },
    caller,
  ];
  return { changes, project };
}

async function lint(changes: SourceFile[], project: ProjectFile[], evaluator: Evaluator) {
  const rule = defaultConfig.rules["jev/no-contract-narrowing-after-ship"];
  expect(rule).toBeDefined();
  if (!rule) return [];
  const config: JevLintConfig = { rules: { "jev/no-contract-narrowing-after-ship": rule } };
  return analyzeChanges({ changes, config, projectFiles: project }, evaluator);
}

liveDescribe("contract narrowing after ship calibration", () => {
  it("flags a required field with a stale caller but keeps an optional one low", async () => {
    const narrowed = scenario(afterNarrowed);
    const optional = scenario(afterOptional);
    const [narrowedJudgments, optionalJudgments] = await Promise.all([
      lint(narrowed.changes, narrowed.project, new PassthroughEvaluator()),
      lint(optional.changes, optional.project, new PassthroughEvaluator()),
    ]);

    expect(narrowedJudgments.map(({ ruleId }) => ruleId)).toContain(
      "jev/no-contract-narrowing-after-ship",
    );
    expect(optionalJudgments.every(({ probability }) => probability < 0.6)).toBe(true);
  });
});
