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
const leakyEvidenceSchema = z.object({
  abstraction: z.object({ name: z.string() }).passthrough(),
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
      const evidence = leakyEvidenceSchema.safeParse(
        candidate?.evidence?.["jev/no-leaky-internal-export"],
      );
      if (evidence.success) this.probabilities.set(evidence.data.abstraction.name, probability);
    }
    return answers;
  }
}

const smelly: ProjectFile[] = [
  {
    filePath: "src/index.ts",
    source: `export interface PublicConfig {
  timeout: number;
}
export * from "./internal/engine.js";
export { createApp } from "./app.js";
`,
  },
  {
    filePath: "src/internal/engine.ts",
    source: `/** @internal engine helper, not public API */
export function tuneEngine(config: unknown) {
  return config;
}
`,
  },
  {
    filePath: "src/app.ts",
    source: `export function createApp() {
  return {};
}
`,
  },
  {
    filePath: "src/boot.ts",
    source: `import { tuneEngine } from "./index.js";
export function boot() {
  return tuneEngine({});
}
`,
  },
];

const clean: ProjectFile[] = [
  {
    filePath: "src/index.ts",
    source: `export interface PublicConfig {
  timeout: number;
}
export { createApp } from "./app.js";
export { formatName } from "./utils.js";
`,
  },
  {
    filePath: "src/app.ts",
    source: `export function createApp() {
  return {};
}
`,
  },
  {
    filePath: "src/utils.ts",
    source: `/** Formats a display name. */
export function formatName(name: string) {
  return name.trim();
}
`,
  },
];

async function lintChangedFile(projectFiles: ProjectFile[], evaluator: Evaluator) {
  const changed = projectFiles[0];
  expect(changed).toBeDefined();
  if (!changed) return [];
  const rule = defaultConfig.rules["jev/no-leaky-internal-export"];
  expect(rule).toBeDefined();
  if (!rule) return [];
  const config: JevLintConfig = { rules: { "jev/no-leaky-internal-export": rule } };
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

liveDescribe("leaky internal export with repository evidence", () => {
  it("separates an internal export-all from a documented public barrel", async () => {
    const evaluator = new RecordingEvaluator();
    const [smellyJudgments, cleanJudgments] = await Promise.all([
      lintChangedFile(smelly, evaluator),
      lintChangedFile(clean, evaluator),
    ]);

    expect(evaluator.probabilities.get("PublicConfig")).toBeGreaterThanOrEqual(0.7);
    expect(smellyJudgments.map(({ ruleId }) => ruleId)).toContain("jev/no-leaky-internal-export");
    expect(cleanJudgments.every(({ probability }) => probability < 0.6)).toBe(true);
  });
});
