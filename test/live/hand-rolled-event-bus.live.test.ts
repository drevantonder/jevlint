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

const SMELLY: ProjectFile = {
  filePath: "src/bus.ts",
  source: "export function createBus() {\n"
    + "  const listeners = new Map<string, Set<(payload: unknown) => void>>();\n"
    + "  return {\n"
    + "    on(topic: string, listener: (payload: unknown) => void): void {\n"
    + "      if (!listeners.has(topic)) listeners.set(topic, new Set());\n"
    + "      listeners.get(topic)?.add(listener);\n"
    + "    },\n"
    + "    off(topic: string, listener: (payload: unknown) => void): void {\n"
    + "      listeners.get(topic)?.delete(listener);\n"
    + "    },\n"
    + "    emit(topic: string, payload: unknown): void {\n"
    + "      listeners.get(topic)?.forEach((listener) => listener(payload));\n"
    + "    },\n"
    + "  };\n"
    + "}\n"
    + "export function publishReady(bus: ReturnType<typeof createBus>): void {\n"
    + "  bus.emit(\"ready\", { at: Date.now() });\n"
    + "}\n",
};
const PAIRED: ProjectFile = {
  filePath: "src/bus.ts",
  source: "export function createTarget(): EventTarget {\n"
    + "  return new EventTarget();\n"
    + "}\n",
};

async function lint(projectFiles: ProjectFile[], evaluator: Evaluator) {
  const changed = projectFiles.find(({ filePath }) => filePath === "src/bus.ts");
  const rule = defaultConfig.rules["jev/no-hand-rolled-event-bus"];
  expect(changed).toBeDefined();
  expect(rule).toBeDefined();
  if (!changed || !rule) return [];
  const config: JevLintConfig = { rules: { "jev/no-hand-rolled-event-bus": rule } };
  return analyzeFile({
    filePath: changed.filePath,
    source: changed.source,
    changedLines: [{ start: 1, end: changed.source.split("\n").length }],
    config,
    projectFiles,
  }, evaluator);
}

liveDescribe("hand rolled event bus with structural evidence", () => {
  it("flags a registry bus but keeps the platform target", async () => {
    const smellyEvaluator = new RecordingEvaluator();
    const cleanEvaluator = new RecordingEvaluator();
    const [smellyJudgments, cleanJudgments] = await Promise.all([
      lint([SMELLY], smellyEvaluator),
      lint([PAIRED], cleanEvaluator),
    ]);

    expect(smellyEvaluator.probabilities.get("src/bus.ts")).toBeGreaterThanOrEqual(0.85);
    expect(smellyJudgments.some(({ probability }) => probability >= 0.85)).toBe(true);
    expect(cleanJudgments.every(({ probability }) => probability < 0.5)).toBe(true);
  });
});
