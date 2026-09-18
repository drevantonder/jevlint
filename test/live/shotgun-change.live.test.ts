import { describe, expect, it } from "vitest";
import { analyzeChanges } from "../../src/analyze.js";
import { defaultConfig } from "../../src/config.js";
import { TypeSafeEvaluator } from "../../src/typesafe-evaluator.js";
import type { EvaluationRequest, Evaluator, JevLintConfig, ProjectFile, SourceFile } from "../../src/types.js";

const liveDescribe = process.env.RUN_LIVE_JEV === "1" ? describe : describe.skip;

class RecordingEvaluator implements Evaluator {
  probabilities: number[] = [];
  readonly delegate = new TypeSafeEvaluator({ apiKey: process.env.JEVLINT_TYPESAFE_API_KEY ?? "" });
  async evaluate(request: EvaluationRequest): Promise<Record<string, number>> {
    const answers = await this.delegate.evaluate(request);
    if (answers.q0 !== undefined) this.probabilities.push(answers.q0);
    return answers;
  }
}

function change(filePath: string, source: string): SourceFile {
  return {
    filePath,
    source,
    oldSource: source,
    changedLines: [{ start: 1, end: source.split("\n").length }],
  };
}

const PARALLEL_A = "import { checkCapability } from \"./capabilities.js\";\n"
  + "export function handleA(user: string): void {\n"
  + "  if (!checkCapability(user, \"export\")) throw new Error(\"denied\");\n"
  + "}\n";
const PARALLEL_B = "import { checkCapability } from \"./capabilities.js\";\n"
  + "export function handleB(user: string): void {\n"
  + "  if (!checkCapability(user, \"export\")) throw new Error(\"denied\");\n"
  + "}\n";
const DISTINCT = "export function formatName(first: string, last: string): string {\n"
  + "  return `${last}, ${first}`;\n"
  + "}\n";

async function lint(files: SourceFile[], evaluator: Evaluator) {
  const rule = defaultConfig.rules["jev/no-shotgun-change"];
  expect(rule).toBeDefined();
  if (!rule) return [];
  const config: JevLintConfig = { rules: { "jev/no-shotgun-change": rule } };
  const projectFiles: ProjectFile[] = files.map(({ filePath, source }) => ({ filePath, source }));
  return analyzeChanges({ changes: files, config, projectFiles }, evaluator);
}

liveDescribe("shotgun change with whole-change evidence", () => {
  it("flags parallel edits across handlers but keeps distinct per-file work", async () => {
    const smellyEvaluator = new RecordingEvaluator();
    const distinctEvaluator = new RecordingEvaluator();
    const [smellyJudgments, distinctJudgments] = await Promise.all([
      lint(
        [change("src/handle-a.ts", PARALLEL_A), change("src/handle-b.ts", PARALLEL_B)],
        smellyEvaluator,
      ),
      lint(
        [change("src/handle-a.ts", PARALLEL_A), change("src/format.ts", DISTINCT)],
        distinctEvaluator,
      ),
    ]);

    expect(smellyEvaluator.probabilities[0]).toBeGreaterThanOrEqual(0.85);
    expect(smellyJudgments.some(({ probability }) => probability >= 0.85)).toBe(true);
    expect(distinctJudgments.every(({ probability }) => probability < 0.5)).toBe(true);
  });
});
