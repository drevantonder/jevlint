import { describe, expect, it } from "vitest";
import { analyzeFile } from "../../src/analyze.js";
import { defaultConfig } from "../../src/config.js";
import { TypeSafeEvaluator } from "../../src/typesafe-evaluator.js";
import type { EvaluationRequest, Evaluator, JevLintConfig, ProjectFile } from "../../src/types.js";

const liveDescribe = process.env.RUN_LIVE_JEV === "1" ? describe : describe.skip;

class RecordingEvaluator implements Evaluator {
  readonly probabilities = new Map<string, number>();
  readonly delegate = new TypeSafeEvaluator();
  async evaluate(request: EvaluationRequest): Promise<Record<string, number>> {
    const answers = await this.delegate.evaluate(request);
    const probability = answers.q0;
    if (probability !== undefined) this.probabilities.set(request.state.file.path, probability);
    return answers;
  }
}

const SMELLY: ProjectFile = {
  filePath: "src/users.ts",
  source: "export async function fetchUser(id: string): Promise<{ name: string }> {\n"
    + "  return getCached(id);\n"
    + "}\n"
    + "declare function getCached(id: string): { name: string };\n",
};
const CALLER: ProjectFile = {
  filePath: "src/show.ts",
  source: "import { fetchUser } from \"./users.js\";\n"
    + "export async function show(id: string): Promise<string> {\n"
    + "  const user = await fetchUser(id);\n"
    + "  return user.name;\n"
    + "}\n",
};
const IGNORED: ProjectFile = {
  filePath: "src/users.ts",
  source: "async function fetchUser(id: string): Promise<{ name: string }> {\n"
    + "  return getCached(id);\n"
    + "}\n"
    + "declare function getCached(id: string): { name: string };\n"
    + "export function show(id: string): void {\n"
    + "  fetchUser(id);\n"
    + "}\n",
};

async function lint(projectFiles: ProjectFile[], evaluator: Evaluator) {
  const changed = projectFiles.find(({ filePath }) => filePath === "src/users.ts");
  const rule = defaultConfig.rules["jev/no-load-bearing-async"];
  expect(changed).toBeDefined();
  expect(rule).toBeDefined();
  if (!changed || !rule) return [];
  const config: JevLintConfig = { rules: { "jev/no-load-bearing-async": rule } };
  return analyzeFile({
    filePath: changed.filePath,
    source: changed.source,
    changedLines: [{ start: 1, end: changed.source.split("\n").length }],
    config,
    projectFiles,
  }, evaluator);
}

liveDescribe("load-bearing async with structural evidence", () => {
  it("flags an awaited marker but keeps one whose callers ignore the return", async () => {
    const smellyEvaluator = new RecordingEvaluator();
    const cleanEvaluator = new RecordingEvaluator();
    const [smellyJudgments, cleanJudgments] = await Promise.all([
      lint([SMELLY, CALLER], smellyEvaluator),
      lint([IGNORED], cleanEvaluator),
    ]);

    expect(smellyEvaluator.probabilities.get("src/users.ts")).toBeGreaterThanOrEqual(0.85);
    expect(smellyJudgments.some(({ probability }) => probability >= 0.85)).toBe(true);
    expect(cleanJudgments.every(({ probability }) => probability < 0.5)).toBe(true);
  });
});
