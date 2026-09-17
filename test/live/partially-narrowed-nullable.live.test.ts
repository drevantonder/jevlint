import { describe, expect, it } from "vitest";
import { analyzeFile } from "../../src/analyze.js";
import { defaultConfig } from "../../src/config.js";
import { TypeSafeEvaluator } from "../../src/typesafe-evaluator.js";
import type { EvaluationRequest, Evaluator, JevLintConfig, ProjectFile } from "../../src/types.js";

const RULE = "jev/no-partially-narrowed-nullable";
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

const SMELLY: ProjectFile = {
  filePath: "src/member-smelly.ts",
  source: "export type Member = { id: string; profile: { name: string } };\n"
    + "export function displayName(member: Member | null | undefined): string {\n"
    + "  if (member === null) return \"guest\";\n"
    + "  return member.profile.name;\n"
    + "}\n",
};
const CLEAN: ProjectFile = {
  filePath: "src/member-clean.ts",
  source: "export type Member = { id: string; profile: { name: string } };\n"
    + "export function displayName(member: Member | null | undefined): string {\n"
    + "  if (member == null) return \"guest\";\n"
    + "  return member.profile.name;\n"
    + "}\n",
};

async function lint(changed: ProjectFile, evaluator: Evaluator) {
  const rule = defaultConfig.rules[RULE];
  expect(rule).toBeDefined();
  if (!rule) return [];
  const config: JevLintConfig = { rules: { [RULE]: rule } };
  return analyzeFile({
    filePath: changed.filePath,
    source: changed.source,
    changedLines: [{ start: 1, end: changed.source.split("\n").length }],
    config,
    projectFiles: [changed],
  }, evaluator);
}

liveDescribe("partially narrowed nullable with structural evidence", () => {
  it("flags single-absence narrowing while full narrowing abstains", async () => {
    const evaluator = new RecordingEvaluator();
    const [smellyJudgments, cleanJudgments] = await Promise.all([
      lint(SMELLY, evaluator),
      lint(CLEAN, new RecordingEvaluator()),
    ]);
    expect(smellyJudgments.map(({ ruleId }) => ruleId)).toContain(RULE);
    expect(cleanJudgments).toEqual([]);
    expect(evaluator.probability).toBeGreaterThanOrEqual(0.7);
  });
});
