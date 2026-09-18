import { readFile } from "node:fs/promises";
import { describe, expect, it } from "vitest";
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
const repositories = new URL("../fixtures/repositories/", import.meta.url);

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

const evaluator = new RecordingEvaluator();

async function project(name: string, paths: string[]): Promise<ProjectFile[]> {
  return Promise.all(paths.map(async (filePath) => ({
    filePath,
    source: await readFile(new URL(`${name}/${filePath}`, repositories), "utf8"),
  })));
}

async function lint(projectFiles: ProjectFile[], filePath: string) {
  const changed = projectFiles.find((file) => file.filePath === filePath);
  const rule = defaultConfig.rules["jev/no-speculative-generality"];
  expect(changed).toBeDefined();
  expect(rule).toBeDefined();
  if (!changed || !rule) return [];
  const config: JevLintConfig = { rules: { "jev/no-speculative-generality": rule } };
  return analyzeFile({
    filePath,
    source: changed.source,
    changedLines: [{ start: 1, end: changed.source.split("\n").length }],
    config,
    projectFiles,
  }, evaluator);
}

liveDescribe("speculative generality with repository evidence", () => {
  it("flags unused flexibility but keeps variation demonstrated by callers", async () => {
    const [smelly, real] = await Promise.all([
      project("speculative-generality-smelly", [
        "src/format-user-name.ts",
        "src/profile.ts",
        "src/audit.ts",
      ]),
      project("speculative-generality-real", [
        "src/serialize-report.ts",
        "src/api.ts",
        "src/download.ts",
      ]),
    ]);

    const [smellyJudgments, realJudgments] = await Promise.all([
      lint(smelly, "src/format-user-name.ts"),
      lint(real, "src/serialize-report.ts"),
    ]);

    expect(evaluator.probabilities.get("src/format-user-name.ts")).toBeGreaterThanOrEqual(0.85);
    expect(evaluator.probabilities.get("src/serialize-report.ts")).toBeLessThan(0.5);
    expect(smellyJudgments.map(({ span }) => span.start.line)).toEqual([8]);
    expect(realJudgments.every(({ probability }) => probability < 0.5)).toBe(true);
  });
});
