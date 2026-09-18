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

const smelly: ProjectFile[] = [{
  filePath: "src/Dialog.tsx",
  source: `export function Dialog({ onClose }: { onClose: () => void }) {
  return (
    <div role="dialog">
      <button onClick={onClose}>
        <Icon />
      </button>
    </div>
  );
}
`,
}];

const labeled: ProjectFile[] = [{
  filePath: "src/DialogLabeled.tsx",
  source: `export function DialogLabeled({ onClose }: { onClose: () => void }) {
  return (
    <div role="dialog">
      <button aria-label="Close" onClick={onClose}>
        <Icon />
      </button>
    </div>
  );
}
`,
}];

async function lint(projectFiles: ProjectFile[], evaluator: Evaluator) {
  const changed = projectFiles[0];
  const rule = defaultConfig.rules["jev/no-unlabeled-interactive-element"];
  expect(changed).toBeDefined();
  expect(rule).toBeDefined();
  if (!changed || !rule) return [];
  const config: JevLintConfig = { rules: { "jev/no-unlabeled-interactive-element": rule } };
  return analyzeFile({
    filePath: changed.filePath,
    source: changed.source,
    changedLines: [{ start: 1, end: changed.source.split("\n").length }],
    config,
    projectFiles,
  }, evaluator);
}

liveDescribe("unlabeled interactive element with structural evidence", () => {
  it("flags an icon-only button but keeps an aria-labeled one", async () => {
    const smellyEvaluator = new RecordingEvaluator();
    const labeledEvaluator = new RecordingEvaluator();
    const [smellyJudgments, labeledJudgments] = await Promise.all([
      lint(smelly, smellyEvaluator),
      lint(labeled, labeledEvaluator),
    ]);

    expect(smellyEvaluator.probabilities.get("src/Dialog.tsx")).toBeGreaterThanOrEqual(0.7);
    expect(smellyJudgments.map(({ ruleId }) => ruleId)).toContain("jev/no-unlabeled-interactive-element");
    expect(labeledJudgments.every(({ probability }) => probability < 0.7)).toBe(true);
  });
});
