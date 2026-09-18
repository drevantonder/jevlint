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

const OWNER = `import { describe } from "vitest";
export function start(): void {
  describe("server", () => {});
}
`;

const MANIFEST = `{
  "name": "shop",
  "dependencies": { "express": "^4.0.0" },
  "devDependencies": { "vitest": "^3.0.0" }
}
`;

async function lint(projectFiles: ProjectFile[], evaluator: Evaluator) {
  const changed = projectFiles[0];
  const rule = defaultConfig.rules["jev/no-dev-dependency-runtime-leak"];
  expect(changed).toBeDefined();
  expect(rule).toBeDefined();
  if (!changed || !rule) return [];
  const config: JevLintConfig = { rules: { "jev/no-dev-dependency-runtime-leak": rule } };
  return analyzeFile({
    filePath: changed.filePath,
    source: changed.source,
    changedLines: [{ start: 1, end: changed.source.split("\n").length }],
    config,
    projectFiles,
  }, evaluator);
}

liveDescribe("dev dependency runtime leak live judgment", () => {
  it("scores a shipped file using a dev-listed package at runtime", async () => {
    const files: ProjectFile[] = [
      { filePath: "src/server.ts", source: OWNER },
      { filePath: "package.json", source: MANIFEST },
    ];
    const evaluator = new RecordingEvaluator();

    const judgments = await lint(files, evaluator);

    expect(judgments.map(({ ruleId }) => ruleId)).toContain("jev/no-dev-dependency-runtime-leak");
    for (const judgment of judgments) {
      expect(judgment.probability).toBeGreaterThanOrEqual(0);
      expect(judgment.probability).toBeLessThanOrEqual(1);
    }
  });
});
