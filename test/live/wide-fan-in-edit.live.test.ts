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

const before = `export function format(code: string): string {
  return code.trim().toLowerCase();
}
`;

const afterBehavioral = `export function format(code: string): string {
  return code.trim().toUpperCase();
}
`;

function caller(label: string): ProjectFile {
  return {
    filePath: `src/${label}.ts`,
    source: `import { format } from "./format";
export function label${label.toUpperCase()}(code: string): string {
  return "${label}:" + format(code);
}
`,
  };
}

type ChangeScenario = {
  changes: SourceFile[];
  project: ProjectFile[];
};

function scenario(after: string): ChangeScenario {
  const changes: SourceFile[] = [{
    filePath: "src/format.ts",
    source: after,
    oldSource: before,
    changedLines: [{ start: 1, end: 3 }],
  }];
  const project: ProjectFile[] = [
    { filePath: "src/format.ts", source: after },
    caller("a"),
    caller("b"),
    caller("c"),
  ];
  return { changes, project };
}

async function lint(changes: SourceFile[], project: ProjectFile[], evaluator: Evaluator) {
  const rule = defaultConfig.rules["jev/no-wide-fan-in-edit"];
  expect(rule).toBeDefined();
  if (!rule) return [];
  const config: JevLintConfig = { rules: { "jev/no-wide-fan-in-edit": rule } };
  return analyzeChanges({ changes, config, projectFiles: project }, evaluator);
}

liveDescribe("wide fan in edit calibration", () => {
  it("flags a behavioral edit to a widely called function but keeps a no-op", async () => {
    const smelly = scenario(afterBehavioral);
    const clean = scenario(before);
    const [smellyJudgments, cleanJudgments] = await Promise.all([
      lint(smelly.changes, smelly.project, new PassthroughEvaluator()),
      lint(clean.changes, clean.project, new PassthroughEvaluator()),
    ]);

    expect(smellyJudgments.map(({ ruleId }) => ruleId)).toContain("jev/no-wide-fan-in-edit");
    expect(cleanJudgments).toHaveLength(0);
  });
});
