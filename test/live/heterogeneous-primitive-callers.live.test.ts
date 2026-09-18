import { describe, expect, it } from "vitest";
import { analyzeFile } from "../../src/analyze.js";
import { defaultConfig } from "../../src/config.js";
import { TypeSafeEvaluator } from "../../src/typesafe-evaluator.js";
import type { EvaluationRequest, Evaluator, JevLintConfig, ProjectFile } from "../../src/types.js";

const RULE = "jev/no-heterogeneous-primitive-callers";
const liveDescribe = process.env.RUN_LIVE_JEV === "1" ? describe : describe.skip;

class RecordingEvaluator implements Evaluator {
  probability: number | undefined;
  readonly delegate = new TypeSafeEvaluator({ apiKey: process.env.TYPESAFE_API_KEY ?? "" });

  async evaluate(request: EvaluationRequest): Promise<Record<string, number>> {
    const answers = await this.delegate.evaluate(request);
    this.probability = answers.q0;
    return answers;
  }
}

const SMELLY: ProjectFile = {
  filePath: "src/lookup.ts",
  source: "export type Account = { id: string; owner: string };\n"
    + "const accounts: Account[] = [];\n"
    + "export function lookupAccount(id: string): Account | undefined {\n"
    + "  return accounts.find((account) => account.id === id);\n"
    + "}\n",
};
const USER_CALLER: ProjectFile = {
  filePath: "src/users.ts",
  source: "import { lookupAccount } from \"./lookup.js\";\n"
    + "export function userAccount(user: { id: string }) {\n"
    + "  return lookupAccount(user.id);\n"
    + "}\n",
};
const ORG_CALLER: ProjectFile = {
  filePath: "src/orgs.ts",
  source: "import { lookupAccount } from \"./lookup.js\";\n"
    + "export function orgAccount(org: { id: string }) {\n"
    + "  return lookupAccount(org.id);\n"
    + "}\n",
};
const CLEAN: ProjectFile = {
  filePath: "src/clean-lookup.ts",
  source: "export function lookupUser(userId: string): string {\n"
    + "  return userId;\n"
    + "}\n",
};
const CLEAN_CALLER: ProjectFile = {
  filePath: "src/clean-users.ts",
  source: "import { lookupUser } from \"./clean-lookup.js\";\n"
    + "export function first(user: { id: string }) {\n"
    + "  return lookupUser(user.id);\n"
    + "}\n"
    + "export function second(user: { id: string }) {\n"
    + "  return lookupUser(user.id);\n"
    + "}\n",
};

async function lint(changed: ProjectFile, evaluator: Evaluator, projectFiles: ProjectFile[]) {
  const rule = defaultConfig.rules[RULE];
  expect(rule).toBeDefined();
  if (!rule) return [];
  const config: JevLintConfig = { rules: { [RULE]: rule } };
  return analyzeFile({
    filePath: changed.filePath,
    source: changed.source,
    changedLines: [{ start: 1, end: changed.source.split("\n").length }],
    config,
    projectFiles,
  }, evaluator);
}

liveDescribe("heterogeneous primitive callers with structural evidence", () => {
  it("flags mixed-stem callers while agreeing stems abstain", async () => {
    const evaluator = new RecordingEvaluator();
    const [smellyJudgments, cleanJudgments] = await Promise.all([
      lint(SMELLY, evaluator, [SMELLY, USER_CALLER, ORG_CALLER]),
      lint(CLEAN, new RecordingEvaluator(), [CLEAN, CLEAN_CALLER]),
    ]);
    expect(smellyJudgments.map(({ ruleId }) => ruleId)).toContain(RULE);
    expect(cleanJudgments).toEqual([]);
    expect(evaluator.probability).toBeGreaterThanOrEqual(0.7);
  });
});
