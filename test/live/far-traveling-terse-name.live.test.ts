import { describe, expect, it } from "vitest";
import { analyzeFile } from "../../src/analyze.js";
import { defaultConfig } from "../../src/config.js";
import { TypeSafeEvaluator } from "../../src/typesafe-evaluator.js";
import type { EvaluationRequest, Evaluator, JevLintConfig, ProjectFile } from "../../src/types.js";

const liveDescribe = process.env.RUN_LIVE_JEV === "1" ? describe : describe.skip;

class RecordingEvaluator implements Evaluator {
  readonly probabilities = new Map<string, number>();
  readonly delegate = new TypeSafeEvaluator({ apiKey: process.env.TYPESAFE_API_KEY ?? "" });
  async evaluate(request: EvaluationRequest): Promise<Record<string, number>> {
    const answers = await this.delegate.evaluate(request);
    const probability = answers.q0;
    if (probability !== undefined) this.probabilities.set(request.state.file.path, probability);
    return answers;
  }
}

const RULE_ID = "jev/no-far-traveling-terse-name";

const SMELLY: ProjectFile = {
  filePath: "src/pipeline.ts",
  source: "export interface OrderInput {\n"
    + "  id: string;\n"
    + "  lines: string[];\n"
    + "}\n"
    + "export function summarizeOrders(d: OrderInput[]): string {\n"
    + "  const out: string[] = [];\n"
    + "  out.push(d.length > 0 ? \"orders\" : \"empty\");\n"
    + "  for (const order of d) {\n"
    + "    out.push(order.id);\n"
    + "  }\n"
    + "  const lines = d.flatMap((order) => order.lines);\n"
    + "  const render = (): string => {\n"
    + "    const head = d.length > 0 ? d[0]?.id ?? \"none\" : \"none\";\n"
    + "    return [head, ...out].join(\",\");\n"
    + "  };\n"
    + "  void lines;\n"
    + "  return render();\n"
    + "}\n",
};
const CLEAN: ProjectFile = {
  filePath: "src/pipeline.ts",
  source: "export function total(values: number[]): number {\n"
    + "  let running = 0;\n"
    + "  for (let i = 0; i < values.length; i += 1) {\n"
    + "    running += values[i] ?? 0;\n"
    + "  }\n"
    + "  return running;\n"
    + "}\n",
};

async function lint(projectFiles: ProjectFile[], evaluator: Evaluator) {
  const changed = projectFiles.find(({ filePath }) => filePath === "src/pipeline.ts");
  const rule = defaultConfig.rules[RULE_ID];
  expect(changed).toBeDefined();
  expect(rule).toBeDefined();
  if (!changed || !rule) return [];
  const config: JevLintConfig = { rules: { [RULE_ID]: rule } };
  return analyzeFile({
    filePath: changed.filePath,
    source: changed.source,
    changedLines: [{ start: 1, end: changed.source.split("\n").length }],
    config,
    projectFiles,
  }, evaluator);
}

liveDescribe("far traveling terse name with structural evidence", () => {
  it("flags the far-traveling terse param but keeps the loop counter", async () => {
    const smellyEvaluator = new RecordingEvaluator();
    const cleanEvaluator = new RecordingEvaluator();
    const [smellyJudgments, cleanJudgments] = await Promise.all([
      lint([SMELLY], smellyEvaluator),
      lint([CLEAN], cleanEvaluator),
    ]);

    expect(smellyEvaluator.probabilities.get("src/pipeline.ts")).toBeGreaterThanOrEqual(0.85);
    expect(smellyJudgments.some(({ probability }) => probability >= 0.85)).toBe(true);
    expect(cleanJudgments.every(({ probability }) => probability < 0.5)).toBe(true);
  });
});
