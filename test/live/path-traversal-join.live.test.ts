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
  filePath: "src/files.ts",
  source: "import path from \"path\";\n"
    + "import fs from \"node:fs\";\n"
    + "export function read(name: string) {\n"
    + "  return fs.readFile(path.join(\"/uploads\", name), \"utf8\");\n"
    + "}\n",
};
const CLEAN: ProjectFile = {
  filePath: "src/files.ts",
  source: "import path from \"path\";\n"
    + "import fs from \"node:fs\";\n"
    + "export function read(name: string) {\n"
    + "  const full = path.normalize(path.join(\"/uploads\", name));\n"
    + "  if (!full.startsWith(\"/uploads\")) throw new Error(\"bad path\");\n"
    + "  return fs.readFile(full, \"utf8\");\n"
    + "}\n",
};

async function lint(projectFiles: ProjectFile[], evaluator: Evaluator) {
  const changed = projectFiles.find(({ filePath }) => filePath === "src/files.ts");
  const rule = defaultConfig.rules["jev/no-path-traversal-join"];
  expect(changed).toBeDefined();
  expect(rule).toBeDefined();
  if (!changed || !rule) return [];
  const config: JevLintConfig = { rules: { "jev/no-path-traversal-join": rule } };
  return analyzeFile({
    filePath: changed.filePath,
    source: changed.source,
    changedLines: [{ start: 1, end: changed.source.split("\n").length }],
    config,
    projectFiles,
  }, evaluator);
}

liveDescribe("path traversal join with structural evidence", () => {
  it("flags an unvalidated segment but keeps a confined one", async () => {
    const smellyEvaluator = new RecordingEvaluator();
    const cleanEvaluator = new RecordingEvaluator();
    const [smellyJudgments, cleanJudgments] = await Promise.all([
      lint([SMELLY], smellyEvaluator),
      lint([CLEAN], cleanEvaluator),
    ]);

    expect(smellyEvaluator.probabilities.get("src/files.ts")).toBeGreaterThanOrEqual(0.7);
    expect(smellyJudgments.some(({ probability }) => probability >= 0.7)).toBe(true);
    expect(cleanJudgments.every(({ probability }) => probability < 0.5)).toBe(true);
  });
});
