import { describe, expect, it } from "vitest";
import { z } from "zod";
import { analyzeFile } from "../../src/analyze.js";
import { defaultConfig } from "../../src/config.js";
import { TypeSafeEvaluator } from "../../src/typesafe-evaluator.js";
import type {
  EvaluationRequest,
  Evaluator,
  JevLintConfig,
  ProjectFile,
} from "../../src/types.js";

const liveDescribe = process.env.RUN_LIVE_JEV === "1" ? describe : describe.skip;
const questionInstructionsSchema = z.object({ inspect: z.string() }).passthrough();
const loopEvidenceSchema = z.object({
  function: z.object({ name: z.string() }).passthrough(),
}).passthrough();

class RecordingEvaluator implements Evaluator {
  readonly probabilities = new Map<string, number>();
  readonly delegate = new TypeSafeEvaluator();

  async evaluate(request: EvaluationRequest): Promise<Record<string, number>> {
    const answers = await this.delegate.evaluate(request);
    for (const [questionId, probability] of Object.entries(answers)) {
      const instructions = questionInstructionsSchema.safeParse(
        request.questions[questionId]?.instructions,
      );
      if (!instructions.success) continue;
      const match = /candidates\[(\d+)]/.exec(instructions.data.inspect);
      const candidate = match?.[1] === undefined
        ? undefined
        : request.state.candidates[Number(match[1])];
      const evidence = loopEvidenceSchema.safeParse(
        candidate?.evidence?.["jev/no-hidden-loop-exit"],
      );
      if (evidence.success) this.probabilities.set(evidence.data.function.name, probability);
    }
    return answers;
  }
}

const smelly: ProjectFile[] = [{
  filePath: "src/drain.ts",
  source: `export function drain(queue: string[]) {
  while (true) {
    const next = queue.shift();
    if (next === undefined || next.startsWith("#") && next.length > 40) {
      break;
    }
    process(next);
  }
}
`,
}];

const clean: ProjectFile[] = [{
  filePath: "src/find.ts",
  source: `export function findUser(users: { id: string }[], id: string) {
  for (const user of users) {
    if (user.id === id) break;
  }
  return null;
}
`,
}];

async function lintChangedFile(projectFiles: ProjectFile[], evaluator: Evaluator) {
  const changed = projectFiles[0];
  expect(changed).toBeDefined();
  if (!changed) return [];
  const rule = defaultConfig.rules["jev/no-hidden-loop-exit"];
  expect(rule).toBeDefined();
  if (!rule) return [];
  const config: JevLintConfig = { rules: { "jev/no-hidden-loop-exit": rule } };
  return analyzeFile(
    {
      filePath: changed.filePath,
      source: changed.source,
      changedLines: [{ start: 1, end: changed.source.split("\n").length }],
      config,
      projectFiles,
    },
    evaluator,
  );
}

liveDescribe("hidden loop exit with repository evidence", () => {
  it("separates a buried compound exit from search-and-stop", async () => {
    const evaluator = new RecordingEvaluator();
    const [smellyJudgments, cleanJudgments] = await Promise.all([
      lintChangedFile(smelly, evaluator),
      lintChangedFile(clean, evaluator),
    ]);

    expect(evaluator.probabilities.get("drain")).toBeGreaterThanOrEqual(0.7);
    expect(evaluator.probabilities.get("findUser")).toBeLessThan(0.6);
    expect(smellyJudgments.map(({ ruleId }) => ruleId)).toContain("jev/no-hidden-loop-exit");
    expect(cleanJudgments.every(({ probability }) => probability < 0.6)).toBe(true);
  });
});
