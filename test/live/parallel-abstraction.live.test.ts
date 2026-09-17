import { describe, expect, it } from "vitest";
import { analyzeFile } from "../../src/analyze.js";
import { defaultConfig } from "../../src/config.js";
import { TypeSafeEvaluator } from "../../src/typesafe-evaluator.js";
import type { EvaluationRequest, Evaluator, JevLintConfig, ProjectFile } from "../../src/types.js";

const liveDescribe = process.env.RUN_LIVE_JEV === "1" ? describe : describe.skip;
const ruleId = "jev/no-parallel-abstraction";

const positive: ProjectFile[] = [
  {
    filePath: "src/notify.ts",
    source: `export class NotificationService {
  send(message: string) {
    console.log(message);
  }
}
export function sendNotification(message: string) {
  new NotificationService().send(message);
}
`,
  },
  {
    filePath: "src/events.ts",
    source: `export class EventDispatcher {
  emit(event: string) {
    console.log(event);
  }
}
export function emitNotification(message: string) {
  new EventDispatcher().emit(message);
}
`,
  },
];

const negative: ProjectFile[] = [
  {
    filePath: "src/notify.ts",
    source: `import { emitNotification } from "./events";
export function sendNotification(message: string) {
  emitNotification(message);
}
`,
  },
  {
    filePath: "src/events.ts",
    source: `export class EventDispatcher {
  emit(event: string) {
    console.log(event);
  }
}
export function emitNotification(message: string) {
  new EventDispatcher().emit(message);
}
`,
  },
];

class RecordingEvaluator implements Evaluator {
  probability: number | undefined;
  readonly delegate = new TypeSafeEvaluator();

  async evaluate(request: EvaluationRequest): Promise<Record<string, number>> {
    const answers = await this.delegate.evaluate(request);
    this.probability = answers.q0;
    return answers;
  }
}

async function calibrate(projectFiles: ProjectFile[]) {
  const changed = projectFiles[0];
  const rule = defaultConfig.rules[ruleId];
  expect(changed).toBeDefined();
  expect(rule).toBeDefined();
  if (!changed || !rule) return { judgments: [], probability: undefined };
  const config: JevLintConfig = { rules: { [ruleId]: rule } };
  const evaluator = new RecordingEvaluator();
  const judgments = await analyzeFile({
    filePath: changed.filePath,
    source: changed.source,
    changedLines: [{ start: 1, end: changed.source.split("\n").length }],
    config,
    projectFiles,
  }, evaluator);
  return { judgments, probability: evaluator.probability };
}

liveDescribe("parallel abstraction calibration", () => {
  it("scores the re-derived concept above the delegating adapter", async () => {
    const [parallel, adapter] = await Promise.all([calibrate(positive), calibrate(negative)]);

    if (parallel.probability === undefined || adapter.probability === undefined) {
      throw new Error("live calibration produced no probability");
    }
    expect(parallel.probability).toBeGreaterThan(adapter.probability);
    expect(parallel.judgments.map(({ ruleId: id }) => id)).toEqual([ruleId]);
  });
});
