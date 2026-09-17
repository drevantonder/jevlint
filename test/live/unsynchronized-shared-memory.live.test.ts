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
const sharedMemoryEvidenceSchema = z.object({
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
      const evidence = sharedMemoryEvidenceSchema.safeParse(
        candidate?.evidence?.["jev/no-unsynchronized-shared-memory"],
      );
      if (evidence.success) this.probabilities.set(evidence.data.function.name, probability);
    }
    return answers;
  }
}

const smelly: ProjectFile[] = [{
  filePath: "src/counter.ts",
  source: `import { Worker } from "node:worker_threads";
const buffer = new SharedArrayBuffer(4);
const view = new Int32Array(buffer);
export function bumpCounter() {
  view[0] += 1;
  const worker = new Worker("./worker.js");
  worker.postMessage(buffer);
  return view[0];
}
`,
}];

const clean: ProjectFile[] = [{
  filePath: "src/counter.ts",
  source: `const buffer = new SharedArrayBuffer(4);
const view = new Int32Array(buffer);
export function readCounter() {
  return view[0];
}
`,
}];

async function lintChangedFile(projectFiles: ProjectFile[], evaluator: Evaluator) {
  const changed = projectFiles[0];
  expect(changed).toBeDefined();
  if (!changed) return [];
  const rule = defaultConfig.rules["jev/no-unsynchronized-shared-memory"];
  expect(rule).toBeDefined();
  if (!rule) return [];
  const config: JevLintConfig = { rules: { "jev/no-unsynchronized-shared-memory": rule } };
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

liveDescribe("unsynchronized shared memory with repository evidence", () => {
  it("separates a plain worker-shared write from a read-only view", async () => {
    const evaluator = new RecordingEvaluator();
    const [smellyJudgments, cleanJudgments] = await Promise.all([
      lintChangedFile(smelly, evaluator),
      lintChangedFile(clean, evaluator),
    ]);

    expect(evaluator.probabilities.get("bumpCounter")).toBeGreaterThanOrEqual(0.7);
    expect(evaluator.probabilities.get("readCounter")).toBeLessThan(0.6);
    expect(smellyJudgments.map(({ ruleId }) => ruleId)).toContain("jev/no-unsynchronized-shared-memory");
    expect(cleanJudgments.every(({ probability }) => probability < 0.6)).toBe(true);
  });
});
