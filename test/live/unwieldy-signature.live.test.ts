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
const ruleId = "jev/no-unwieldy-signature";
const questionInstructionsSchema = z.object({ inspect: z.string() }).passthrough();
const evidenceSchema = z.object({
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
      const evidence = evidenceSchema.safeParse(candidate?.evidence?.[ruleId]);
      if (evidence.success) this.probabilities.set(evidence.data.function.name, probability);
    }
    return answers;
  }
}

const repositories = new URL("../fixtures/repositories/", import.meta.url);

async function project(name: string, paths: string[]): Promise<ProjectFile[]> {
  return Promise.all(paths.map(async (filePath) => ({
    filePath,
    source: await readFile(new URL(`${name}/${filePath}`, repositories), "utf8"),
  })));
}

async function lintChangedFile(
  projectFiles: ProjectFile[],
  filePath: string,
  evaluator: Evaluator,
) {
  const changed = projectFiles.find((file) => file.filePath === filePath);
  expect(changed).toBeDefined();
  if (!changed) return [];
  const rule = defaultConfig.rules[ruleId];
  expect(rule).toBeDefined();
  if (!rule) return [];
  const config: JevLintConfig = { rules: { [ruleId]: rule } };
  return analyzeFile(
    {
      filePath,
      source: changed.source,
      changedLines: [{ start: 1, end: changed.source.split("\n").length }],
      config,
      projectFiles,
    },
    evaluator,
  );
}

liveDescribe("unwieldy signature calibration", () => {
  it("flags placeholder-driven signatures but keeps usable ones", async () => {
    const evaluator = new RecordingEvaluator();
    const projectFiles = await project("unwieldy-signature-smelly", [
      "src/update-user.ts",
      "src/admin.ts",
    ]);

    const judgments = await lintChangedFile(projectFiles, "src/update-user.ts", evaluator);

    expect(evaluator.probabilities.get("updateUser")).toBeGreaterThanOrEqual(0.7);
    expect(evaluator.probabilities.get("renameUser")).toBeLessThan(0.6);
    expect(judgments.map(({ ruleId: judged }) => judged)).toContain(ruleId);
  });
});
