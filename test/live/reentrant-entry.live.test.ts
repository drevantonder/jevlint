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
const entryEvidenceSchema = z.object({
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
      const evidence = entryEvidenceSchema.safeParse(
        candidate?.evidence?.["jev/no-reentrant-entry"],
      );
      if (evidence.success) this.probabilities.set(evidence.data.function.name, probability);
    }
    return answers;
  }
}

const caller: ProjectFile = {
  filePath: "src/app.ts",
  source: `import { enqueue, processQueue } from "./queue";
export function boot(): void {
  enqueue("first");
  processQueue();
}
`,
};

const smelly: ProjectFile[] = [
  caller,
  {
    filePath: "src/queue.ts",
    source: `import { EventEmitter } from "node:events";
export const bus = new EventEmitter();
let pending: string[] = [];
export function enqueue(item: string): void {
  pending.push(item);
}
export function processQueue(): string[] {
  const batch = pending;
  pending = [];
  return batch;
}
bus.on("drain", processQueue);
`,
  },
];

const clean: ProjectFile[] = [
  caller,
  {
    filePath: "src/queue.ts",
    source: `import { EventEmitter } from "node:events";
export const bus = new EventEmitter();
let pending: string[] = [];
let inProgress = false;
export function enqueue(item: string): void {
  pending.push(item);
}
export function processQueue(): string[] {
  if (inProgress) return [];
  inProgress = true;
  try {
    const batch = pending;
    pending = [];
    return batch;
  } finally {
    inProgress = false;
  }
}
bus.on("drain", processQueue);
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
  const rule = defaultConfig.rules["jev/no-reentrant-entry"];
  expect(rule).toBeDefined();
  if (!rule) return [];
  const config: JevLintConfig = { rules: { "jev/no-reentrant-entry": rule } };
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

liveDescribe("reentrant entry with reachability evidence", () => {
  it("separates an unguarded dual entry from a guarded one", async () => {
    const smellyEvaluator = new RecordingEvaluator();
    const cleanEvaluator = new RecordingEvaluator();
    const [smellyJudgments, cleanJudgments] = await Promise.all([
      lintChangedFile(smelly, "src/queue.ts", smellyEvaluator),
      lintChangedFile(clean, "src/queue.ts", cleanEvaluator),
    ]);

    expect(smellyEvaluator.probabilities.get("processQueue")).toBeGreaterThanOrEqual(0.7);
    expect(smellyJudgments.map(({ ruleId }) => ruleId)).toContain("jev/no-reentrant-entry");
    expect(cleanJudgments.every(({ probability }) => probability < 0.6)).toBe(true);
  });
});
