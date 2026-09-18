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
const siblingEvidenceSchema = z.object({
  function: z.object({ name: z.string() }).passthrough(),
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
      const evidence = siblingEvidenceSchema.safeParse(
        candidate?.evidence?.["jev/no-sync-async-sibling-ambiguity"],
      );
      if (evidence.success) this.probabilities.set(evidence.data.function.name, probability);
    }
    return answers;
  }
}

const smelly: ProjectFile[] = [{
  filePath: "src/loader.ts",
  source: `import { readFileSync } from "node:fs";
export function load(path: string) {
  return readFileSync(path, "utf8");
}
export async function loadRemote(url: string): Promise<string> {
  const response = await fetch(url);
  return response.text();
}
`,
}];

const clean: ProjectFile[] = [{
  filePath: "src/reader.ts",
  source: `import { readFileSync } from "node:fs";
import { readFile } from "node:fs/promises";
export async function read(path: string): Promise<string> {
  return readFile(path, "utf8");
}
export function readSync(path: string) {
  return readFileSync(path, "utf8");
}
`,
}];

async function lintChangedFile(projectFiles: ProjectFile[], evaluator: Evaluator) {
  const changed = projectFiles[0];
  expect(changed).toBeDefined();
  if (!changed) return [];
  const rule = defaultConfig.rules["jev/no-sync-async-sibling-ambiguity"];
  expect(rule).toBeDefined();
  if (!rule) return [];
  const config: JevLintConfig = { rules: { "jev/no-sync-async-sibling-ambiguity": rule } };
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

liveDescribe("sync async sibling ambiguity with repository evidence", () => {
  it("separates an unsuffixed mixed pair from a platform-convention pair", async () => {
    const evaluator = new RecordingEvaluator();
    const [smellyJudgments, cleanJudgments] = await Promise.all([
      lintChangedFile(smelly, evaluator),
      lintChangedFile(clean, evaluator),
    ]);

    expect(evaluator.probabilities.get("loadRemote")).toBeGreaterThanOrEqual(0.7);
    expect(evaluator.probabilities.get("readSync")).toBeLessThan(0.6);
    expect(smellyJudgments.map(({ ruleId }) => ruleId)).toContain("jev/no-sync-async-sibling-ambiguity");
    expect(cleanJudgments.every(({ probability }) => probability < 0.6)).toBe(true);
  });
});
