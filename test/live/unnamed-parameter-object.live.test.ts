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

const SMELLY: ProjectFile = {
  filePath: "src/users.ts",
  source: "export function createUser(userName: string, userEmail: string, userRole: string, userPlan: string, userLocale: string): string {\n"
    + "  const record = { userName, userEmail, userRole, userPlan, userLocale };\n"
    + "  return JSON.stringify(record);\n"
    + "}\n",
};
const CALLER: ProjectFile = {
  filePath: "src/signup.ts",
  source: "import { createUser } from \"./users.js\";\n"
    + "export function signup(form: { name: string; email: string; role: string; plan: string; locale: string }): string {\n"
    + "  return createUser(form.name, form.email, form.role, form.plan, form.locale);\n"
    + "}\n",
};
const SELF_DESCRIBING: ProjectFile = {
  filePath: "src/users.ts",
  source: "export function add(first: number, second: number): number {\n"
    + "  return first + second;\n"
    + "}\n",
};

async function lint(projectFiles: ProjectFile[], evaluator: Evaluator) {
  const changed = projectFiles.find(({ filePath }) => filePath === "src/users.ts");
  const rule = defaultConfig.rules["jev/no-unnamed-parameter-object"];
  expect(changed).toBeDefined();
  expect(rule).toBeDefined();
  if (!changed || !rule) return [];
  const config: JevLintConfig = { rules: { "jev/no-unnamed-parameter-object": rule } };
  return analyzeFile({
    filePath: changed.filePath,
    source: changed.source,
    changedLines: [{ start: 1, end: changed.source.split("\n").length }],
    config,
    projectFiles,
  }, evaluator);
}

liveDescribe("unnamed parameter object with structural evidence", () => {
  it("flags caller-held object split into slots but keeps a coincidental pair", async () => {
    const smellyEvaluator = new RecordingEvaluator();
    const cleanEvaluator = new RecordingEvaluator();
    const [smellyJudgments, cleanJudgments] = await Promise.all([
      lint([SMELLY, CALLER], smellyEvaluator),
      lint([SELF_DESCRIBING], cleanEvaluator),
    ]);

    expect(smellyEvaluator.probabilities.get("src/users.ts")).toBeGreaterThanOrEqual(0.85);
    expect(smellyJudgments.some(({ probability }) => probability >= 0.85)).toBe(true);
    expect(cleanJudgments.every(({ probability }) => probability < 0.5)).toBe(true);
  });
});
