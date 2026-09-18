import { describe, expect, it } from "vitest";
import { analyzeFile } from "../../src/analyze.js";
import { defaultConfig } from "../../src/config.js";
import { TypeSafeEvaluator } from "../../src/typesafe-evaluator.js";
import type { EvaluationRequest, Evaluator, JevLintConfig, ProjectFile } from "../../src/types.js";

const liveDescribe = process.env.RUN_LIVE_JEV === "1" ? describe : describe.skip;

class RecordingEvaluator implements Evaluator {
  readonly probabilities = new Map<string, number>();
  readonly delegate = new TypeSafeEvaluator({ apiKey: process.env.TYPESAFE_API_KEY ?? "" });
  async evaluate(request: EvaluationRequest): Promise<Record<string, number>> {
    const answers = await this.delegate.evaluate(request);
    const probability = answers.q0;
    if (probability !== undefined) this.probabilities.set(request.state.file.path, probability);
    return answers;
  }
}

const OWNER = `import { open, read } from "./store.js";
export function boot(id: string): string {
  open(id);
  return read();
}
`;

const STORE = `let current: string | undefined;
export function open(id: string): void {
  current = id;
}
export function read(): string {
  return current ?? "none";
}
`;

async function lint(projectFiles: ProjectFile[], evaluator: Evaluator) {
  const changed = projectFiles[0];
  const rule = defaultConfig.rules["jev/no-cross-module-call-order"];
  expect(changed).toBeDefined();
  expect(rule).toBeDefined();
  if (!changed || !rule) return [];
  const config: JevLintConfig = { rules: { "jev/no-cross-module-call-order": rule } };
  return analyzeFile({
    filePath: changed.filePath,
    source: changed.source,
    changedLines: [{ start: 1, end: changed.source.split("\n").length }],
    config,
    projectFiles,
  }, evaluator);
}

liveDescribe("cross module call order live judgment", () => {
  it("scores an unverifiable writer-then-reader order across modules", async () => {
    const files: ProjectFile[] = [
      { filePath: "src/app.ts", source: OWNER },
      { filePath: "src/store.ts", source: STORE },
    ];
    const evaluator = new RecordingEvaluator();

    const judgments = await lint(files, evaluator);

    expect(judgments.map(({ ruleId }) => ruleId)).toContain("jev/no-cross-module-call-order");
    for (const judgment of judgments) {
      expect(judgment.probability).toBeGreaterThanOrEqual(0);
      expect(judgment.probability).toBeLessThanOrEqual(1);
    }
  });
});
