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
const contextEvidenceSchema = z.object({
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
      const evidence = contextEvidenceSchema.safeParse(
        candidate?.evidence?.["jev/no-excess-context-parameter"],
      );
      if (evidence.success) this.probabilities.set(evidence.data.function.name, probability);
    }
    return answers;
  }
}

const config: ProjectFile = {
  filePath: "src/config.ts",
  source: `export type AppConfig = {
  timeout: number;
  retries: number;
  endpoint: string;
  apiKey: string;
  region: string;
  logLevel: string;
};
export function loadAppConfig(): AppConfig {
  throw new Error("unimplemented");
}
`,
};

const smelly: ProjectFile[] = [
  config,
  {
    filePath: "src/render.ts",
    source: `import { loadAppConfig, type AppConfig } from "./config";
export function renderTimeout(appConfig: AppConfig) {
  return appConfig.timeout;
}
renderTimeout(loadAppConfig());
`,
  },
];

const clean: ProjectFile[] = [{
  filePath: "src/point.ts",
  source: `export type Point = { x: number; y: number };
export function distance(point: Point) {
  return Math.sqrt(point.x * point.x + point.y * point.y);
}
`,
}];

async function lintChangedFile(
  projectFiles: ProjectFile[],
  filePath: string,
  evaluator: Evaluator,
) {
  const changed = projectFiles.find((file) => file.filePath === filePath);
  expect(changed).toBeDefined();
  if (!changed) return [];
  const rule = defaultConfig.rules["jev/no-excess-context-parameter"];
  expect(rule).toBeDefined();
  if (!rule) return [];
  const config: JevLintConfig = { rules: { "jev/no-excess-context-parameter": rule } };
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

liveDescribe("excess context parameter with repository evidence", () => {
  it("separates one-member reads from fully used parameters", async () => {
    const evaluator = new RecordingEvaluator();
    const [smellyJudgments, cleanJudgments] = await Promise.all([
      lintChangedFile(smelly, "src/render.ts", evaluator),
      lintChangedFile(clean, "src/point.ts", evaluator),
    ]);

    expect(evaluator.probabilities.get("renderTimeout")).toBeGreaterThanOrEqual(0.7);
    expect(evaluator.probabilities.get("distance")).toBeLessThan(0.6);
    expect(smellyJudgments.map(({ ruleId }) => ruleId)).toContain("jev/no-excess-context-parameter");
    expect(cleanJudgments.every(({ probability }) => probability < 0.6)).toBe(true);
  });
});
