import { describe, expect, it } from "vitest";
import { analyzeFile } from "../../src/analyze.js";
import { defaultConfig } from "../../src/config.js";
import { TypeSafeEvaluator } from "../../src/typesafe-evaluator.js";
import type { EvaluationRequest, Evaluator, JevLintConfig, ProjectFile } from "../../src/types.js";

const liveDescribe = process.env.RUN_LIVE_JEV === "1" ? describe : describe.skip;

class RecordingEvaluator implements Evaluator {
  readonly probabilities = new Map<string, number>();
  readonly delegate = new TypeSafeEvaluator({ apiKey: process.env.JEVLINT_TYPESAFE_API_KEY ?? "" });
  async evaluate(request: EvaluationRequest): Promise<Record<string, number>> {
    const answers = await this.delegate.evaluate(request);
    const probability = answers.q0;
    if (probability !== undefined) this.probabilities.set(request.state.file.path, probability);
    return answers;
  }
}

const SMELLY: ProjectFile = {
  filePath: "src/handle.ts",
  source: "export function handle(tenantId: string): string {\n"
    + "  return authorize(tenantId);\n"
    + "}\n"
    + "function authorize(tenantId: string): string {\n"
    + "  return load(tenantId);\n"
    + "}\n",
};
const MID: ProjectFile = {
  filePath: "src/load.ts",
  source: "export function load(tenantId: string): string {\n"
    + "  return read(tenantId);\n"
    + "}\n"
    + "function read(tenantId: string): string {\n"
    + "  return tenantId.trim();\n"
    + "}\n",
};
const CLEAN: ProjectFile = {
  filePath: "src/handle.ts",
  source: "export function handle(tenantId: string): string {\n"
    + "  if (tenantId.length === 0) {\n"
    + "    throw new Error(\"missing tenant\");\n"
    + "  }\n"
    + "  return authorize(tenantId);\n"
    + "}\n"
    + "function authorize(tenantId: string): string {\n"
    + "  return tenantId;\n"
    + "}\n",
};

async function lint(projectFiles: ProjectFile[], evaluator: Evaluator) {
  const changed = projectFiles.find(({ filePath }) => filePath === "src/handle.ts");
  const rule = defaultConfig.rules["jev/no-transitive-plumbing"];
  expect(changed).toBeDefined();
  expect(rule).toBeDefined();
  if (!changed || !rule) return [];
  const config: JevLintConfig = { rules: { "jev/no-transitive-plumbing": rule } };
  return analyzeFile({
    filePath: changed.filePath,
    source: changed.source,
    changedLines: [{ start: 1, end: changed.source.split("\n").length }],
    config,
    projectFiles,
  }, evaluator);
}

liveDescribe("transitive plumbing with structural evidence", () => {
  it("flags an unread forwarded value but keeps a value the layer reads", async () => {
    const smellyEvaluator = new RecordingEvaluator();
    const cleanEvaluator = new RecordingEvaluator();
    const [smellyJudgments, cleanJudgments] = await Promise.all([
      lint([SMELLY, MID], smellyEvaluator),
      lint([CLEAN], cleanEvaluator),
    ]);

    expect(smellyEvaluator.probabilities.get("src/handle.ts")).toBeGreaterThanOrEqual(0.85);
    expect(smellyJudgments.some(({ probability }) => probability >= 0.85)).toBe(true);
    expect(cleanJudgments.every(({ probability }) => probability < 0.5)).toBe(true);
  });
});
