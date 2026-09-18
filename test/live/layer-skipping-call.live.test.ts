import { describe, expect, it } from "vitest";
import { analyzeFile } from "../../src/analyze.js";
import { defaultConfig } from "../../src/config.js";
import { TypeSafeEvaluator } from "../../src/typesafe-evaluator.js";
import type { EvaluationRequest, Evaluator, JevLintConfig, ProjectFile } from "../../src/types.js";

const liveDescribe = process.env.RUN_LIVE_JEV === "1" ? describe : describe.skip;

class RecordingEvaluator implements Evaluator {
  readonly probabilities = new Map<string, number>();
  readonly delegate = new TypeSafeEvaluator({ apiKey: process.env.JEVLINT_TYPESAFE_API_KEY ?? "" });
  async evaluate(request: EvaluationRequest): Promise<Record<string, number>> {
    const answers = await this.delegate.evaluate(request);
    const probability = answers.q0;
    if (probability !== undefined) this.probabilities.set(request.state.file.path, probability);
    return answers;
  }
}

const HANDLER = `import { getOrder } from "../services/orderService.js";
import { readRow } from "../db/orderStore.js";
export function handle(id: string): string {
  getOrder(id);
  return readRow(id);
}
`;

const SERVICE = `import { readRow } from "../db/orderStore.js";
export function getOrder(id: string): string {
  if (!id) throw new Error("missing id");
  return readRow(id);
}
`;

const STORE = `export function readRow(id: string): string {
  return id;
}
`;

async function lint(projectFiles: ProjectFile[], evaluator: Evaluator) {
  const changed = projectFiles[0];
  const rule = defaultConfig.rules["jev/no-layer-skipping-call"];
  expect(changed).toBeDefined();
  expect(rule).toBeDefined();
  if (!changed || !rule) return [];
  const config: JevLintConfig = { rules: { "jev/no-layer-skipping-call": rule } };
  return analyzeFile({
    filePath: changed.filePath,
    source: changed.source,
    changedLines: [{ start: 1, end: changed.source.split("\n").length }],
    config,
    projectFiles,
  }, evaluator);
}

liveDescribe("layer skipping call live judgment", () => {
  it("scores a direct deep call past a guard-bearing intermediate", async () => {
    const files: ProjectFile[] = [
      { filePath: "routes/order.ts", source: HANDLER },
      { filePath: "services/orderService.ts", source: SERVICE },
      { filePath: "db/orderStore.ts", source: STORE },
    ];
    const evaluator = new RecordingEvaluator();

    const judgments = await lint(files, evaluator);

    expect(judgments.map(({ ruleId }) => ruleId)).toContain("jev/no-layer-skipping-call");
    for (const judgment of judgments) {
      expect(judgment.probability).toBeGreaterThanOrEqual(0);
      expect(judgment.probability).toBeLessThanOrEqual(1);
    }
  });
});
