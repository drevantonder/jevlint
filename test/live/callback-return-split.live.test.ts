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
const splitEvidenceSchema = z.object({
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
      const evidence = splitEvidenceSchema.safeParse(
        candidate?.evidence?.["jev/no-callback-return-split"],
      );
      if (evidence.success) this.probabilities.set(evidence.data.function.name, probability);
    }
    return answers;
  }
}

const client: ProjectFile = {
  filePath: "src/app.ts",
  source: `import { get, remove, save } from "./store";
export async function handle(key: string): Promise<string | undefined> {
  const value = await get(key);
  if (value === undefined) return undefined;
  await save(key, value);
  remove(key, () => {});
  return value;
}
`,
};

const smelly: ProjectFile[] = [
  client,
  {
    filePath: "src/store.ts",
    source: `export async function get(key: string): Promise<string | undefined> {
  return store.get(key);
}
export async function save(key: string, value: string): Promise<void> {
  store.set(key, value);
}
export function remove(key: string, cb: (error: Error | null) => void): void {
  store.delete(key);
  cb(null);
}
const store = new Map<string, string>();
`,
  },
];

const clean: ProjectFile[] = [
  {
    filePath: "src/app.ts",
    source: `import { get, save } from "./store";
export async function handle(key: string): Promise<string | undefined> {
  const value = await get(key);
  if (value === undefined) return undefined;
  await save(key, value);
  return value;
}
`,
  },
  {
    filePath: "src/store.ts",
    source: `export async function get(key: string): Promise<string | undefined> {
  return store.get(key);
}
export async function save(key: string, value: string): Promise<void> {
  store.set(key, value);
}
export async function clear(): Promise<void> {
  store.clear();
}
const store = new Map<string, string>();
`,
  },
];

async function lintChangedFile(
  projectFiles: ProjectFile[],
  filePath: string,
  evaluator: Evaluator,
) {
  const changed = projectFiles.find((file) => file.filePath === filePath);
  expect(changed).toBeDefined();
  if (!changed) return [];
  const rule = defaultConfig.rules["jev/no-callback-return-split"];
  expect(rule).toBeDefined();
  if (!rule) return [];
  const config: JevLintConfig = { rules: { "jev/no-callback-return-split": rule } };
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

liveDescribe("callback return split with module surface evidence", () => {
  it("separates a callback outlier from a uniform return surface", async () => {
    const smellyEvaluator = new RecordingEvaluator();
    const cleanEvaluator = new RecordingEvaluator();
    const [smellyJudgments, cleanJudgments] = await Promise.all([
      lintChangedFile(smelly, "src/store.ts", smellyEvaluator),
      lintChangedFile(clean, "src/store.ts", cleanEvaluator),
    ]);

    expect(smellyEvaluator.probabilities.get("remove")).toBeGreaterThanOrEqual(0.7);
    expect(smellyJudgments.map(({ ruleId }) => ruleId)).toContain(
      "jev/no-callback-return-split",
    );
    expect(cleanJudgments.every(({ probability }) => probability < 0.6)).toBe(true);
  });
});
