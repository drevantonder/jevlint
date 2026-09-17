import { describe, expect, it } from "vitest";
import { analyzeModules } from "../../src/analyze.js";
import { defaultConfig } from "../../src/config.js";
import { TypeSafeEvaluator } from "../../src/typesafe-evaluator.js";
import type { EvaluationRequest, Evaluator, JevLintConfig, ProjectFile, SourceFile } from "../../src/types.js";

const liveDescribe = process.env.RUN_LIVE_JEV === "1" ? describe : describe.skip;

class RecordingEvaluator implements Evaluator {
  probability: number | undefined;
  readonly delegate = new TypeSafeEvaluator();

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

const SKEWED = `import { format, parse, validate, serialize } from "./toolbox.js";
export function run(raw: string): string {
  return format(raw);
}
`;

const BALANCED_BEFORE = `import { format } from "./format.js";
export function run(raw: string): string {
  return format(raw);
}
`;

const TOOLBOX = `export function format(value: string): string {
  return value;
}
export function parse(value: string): string {
  return value;
}
export function validate(value: string): boolean {
  return value.length > 0;
}
export function serialize(value: string): string {
  return value;
}
`;

liveDescribe("import use skew live judgment", () => {
  it("scores a file importing a wide surface it barely exercises", async () => {
    const files = [
      projectFile("features/worker/run.ts", SKEWED),
      projectFile("features/worker/toolbox.ts", TOOLBOX),
      ...Array.from({ length: 9 }, (_, index) => projectFile(`features/extra/widget-${index}.ts`)),
    ];
    const changes: SourceFile[] = [{
      filePath: "features/worker/run.ts",
      source: SKEWED,
      oldSource: BALANCED_BEFORE,
      changedLines: [{ start: 1, end: 1 }],
    }];

    const { judgments, probability } = await judge("jev/no-import-use-skew", files, changes);

    expect(judgments[0]?.ruleId).toBe("jev/no-import-use-skew");
    expect(probability).toBeGreaterThanOrEqual(0.85);
    expect(judgments.some(({ probability }) => probability >= 0.85)).toBe(true);
  });
});
