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

const TYPES: ProjectFile = {
  filePath: "src/types.ts",
  source: "import type { Profile } from \"./internal/profile.js\";\n"
    + "export interface User {\n"
    + "  id: string;\n"
    + "  profile: Profile;\n"
    + "}\n",
};
const INTERNAL_PROFILE: ProjectFile = {
  filePath: "src/internal/profile.ts",
  source: "/** @internal Test-only shape, do not depend on this. */\n"
    + "export interface Profile {\n"
    + "  nickname: string;\n"
    + "}\n",
};
const CONSUMER: ProjectFile = {
  filePath: "src/greet.ts",
  source: "import type { User } from \"./types.js\";\n"
    + "export function greet(user: User): string {\n"
    + "  return user.id;\n"
    + "}\n",
};
const CONSUMER_B: ProjectFile = {
  filePath: "src/label.ts",
  source: "import type { User } from \"./types.js\";\n"
    + "export function label(user: User): string {\n"
    + "  return user.profile.nickname;\n"
    + "}\n",
};
const CONSUMER_C: ProjectFile = {
  filePath: "src/rename.ts",
  source: "import type { User } from \"./types.js\";\n"
    + "export function rename(user: User, nickname: string): void {\n"
    + "  user.profile.nickname = nickname;\n"
    + "}\n",
};
const CONSUMER_D: ProjectFile = {
  filePath: "src/compare.ts",
  source: "import type { User } from \"./types.js\";\n"
    + "export function same(a: User, b: User): boolean {\n"
    + "  return a.id === b.id;\n"
    + "}\n",
};
const CALM_TYPES: ProjectFile = {
  filePath: "src/types.ts",
  source: "export interface User {\n"
    + "  id: string;\n"
    + "  nickname: string;\n"
    + "}\n",
};

async function lint(projectFiles: ProjectFile[], evaluator: Evaluator) {
  const changed = projectFiles.find(({ filePath }) => filePath === "src/types.ts");
  const rule = defaultConfig.rules["jev/no-stability-inversion"];
  expect(changed).toBeDefined();
  expect(rule).toBeDefined();
  if (!changed || !rule) return [];
  const config: JevLintConfig = { rules: { "jev/no-stability-inversion": rule } };
  return analyzeFile({
    filePath: changed.filePath,
    source: changed.source,
    changedLines: [{ start: 1, end: changed.source.split("\n").length }],
    config,
    projectFiles,
  }, evaluator);
}

liveDescribe("stability inversion live judgment", () => {
  it("scores a used type depending on an internal module above a self-contained type", async () => {
    const invertedEvaluator = new RecordingEvaluator();
    const calmEvaluator = new RecordingEvaluator();
    const [invertedJudgments, calmJudgments] = await Promise.all([
      lint([TYPES, INTERNAL_PROFILE, CONSUMER, CONSUMER_B, CONSUMER_C, CONSUMER_D], invertedEvaluator),
      lint([CALM_TYPES, CONSUMER], calmEvaluator),
    ]);

    expect(invertedEvaluator.probabilities.get("src/types.ts")).toBeGreaterThanOrEqual(0.85);
    expect(invertedJudgments.some(({ probability }) => probability >= 0.85)).toBe(true);
    expect(calmJudgments.every(({ probability }) => probability < 0.5)).toBe(true);
  });
});
