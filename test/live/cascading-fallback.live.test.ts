import { readFile } from "node:fs/promises";
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
const repositories = new URL("../fixtures/repositories/", import.meta.url);
const ruleId = "jev/no-cascading-fallback";

const questionInstructionsSchema = z.object({ inspect: z.string() }).passthrough();
const fallbackEvidenceSchema = z.object({
  function: z.object({ name: z.string().nullable() }).passthrough(),
}).passthrough();

class RecordingEvaluator implements Evaluator {
  readonly probabilities = new Map<string, number>();
  readonly delegate = new TypeSafeEvaluator({ apiKey: process.env.TYPESAFE_API_KEY ?? "" });

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
      const evidence = fallbackEvidenceSchema.safeParse(candidate?.evidence?.[ruleId]);
      if (evidence.success && evidence.data.function.name) {
        this.probabilities.set(evidence.data.function.name, probability);
      }
    }
    return answers;
  }
}

async function loadProject(name: string, paths: string[]): Promise<ProjectFile[]> {
  return Promise.all(paths.map(async (filePath) => ({
    filePath,
    source: await readFile(new URL(`${name}/${filePath}`, repositories), "utf8"),
  })));
}

async function lintChangedFile(projectFiles: ProjectFile[], evaluator: Evaluator) {
  const changed = projectFiles[0];
  expect(changed).toBeDefined();
  if (!changed) return [];
  const rule = defaultConfig.rules[ruleId];
  expect(rule).toBeDefined();
  if (!rule) return [];
  const config: JevLintConfig = { rules: { [ruleId]: rule } };
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

liveDescribe("cascading fallback calibration", () => {
  it("separates the same-pool fallback from the static-cache fallback", async () => {
    const smellyEvaluator = new RecordingEvaluator();
    const cleanEvaluator = new RecordingEvaluator();
    const [smellyJudgments, cleanJudgments] = await Promise.all([
      loadProject("cascading-fallback-positive", [
        "src/fetch-user.ts",
        "src/db.ts",
        "src/caller.ts",
      ]).then((files) => lintChangedFile(files, smellyEvaluator)),
      loadProject("cascading-fallback-negative", [
        "src/fetch-user.ts",
        "src/db.ts",
      ]).then((files) => lintChangedFile(files, cleanEvaluator)),
    ]);

    expect(smellyEvaluator.probabilities.get("fetchUser")).toBeGreaterThanOrEqual(0.7);
    expect(smellyJudgments.map(({ ruleId: id }) => id)).toContain(ruleId);
    expect(cleanJudgments.every(({ probability }) => probability < 0.7)).toBe(true);
  });
});
