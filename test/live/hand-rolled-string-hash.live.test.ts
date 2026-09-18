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

const SMELLY: ProjectFile = {
  filePath: "src/hash.ts",
  source: "import { createHash } from \"node:crypto\";\n"
    + "export function fingerprintKey(key: string): string {\n"
    + "  return createHash(\"sha256\").update(key).digest(\"hex\").slice(0, 8);\n"
    + "}\n"
    + "export function bucketHash(value: string): number {\n"
    + "  let hash = 5381;\n"
    + "  for (let index = 0; index < value.length; index += 1) {\n"
    + "    hash = ((hash << 5) + hash + value.charCodeAt(index)) | 0;\n"
    + "  }\n"
    + "  return hash;\n"
    + "}\n"
    + "export function bucketFor(key: string, width: number): number {\n"
    + "  return bucketHash(key) % width;\n"
    + "}\n",
};
const PAIRED: ProjectFile = {
  filePath: "src/hash.ts",
  source: "import { createHash } from \"node:crypto\";\n"
    + "export function bucketDigest(value: string): string {\n"
    + "  return createHash(\"sha256\").update(value).digest(\"hex\");\n"
    + "}\n",
};

async function lint(projectFiles: ProjectFile[], evaluator: Evaluator) {
  const changed = projectFiles.find(({ filePath }) => filePath === "src/hash.ts");
  const rule = defaultConfig.rules["jev/no-hand-rolled-string-hash"];
  expect(changed).toBeDefined();
  expect(rule).toBeDefined();
  if (!changed || !rule) return [];
  const config: JevLintConfig = { rules: { "jev/no-hand-rolled-string-hash": rule } };
  return analyzeFile({
    filePath: changed.filePath,
    source: changed.source,
    changedLines: [{ start: 1, end: changed.source.split("\n").length }],
    config,
    projectFiles,
  }, evaluator);
}

liveDescribe("hand rolled string hash with structural evidence", () => {
  it("flags a djb2 fold but keeps the crypto digest", async () => {
    const smellyEvaluator = new RecordingEvaluator();
    const cleanEvaluator = new RecordingEvaluator();
    const [smellyJudgments, cleanJudgments] = await Promise.all([
      lint([SMELLY], smellyEvaluator),
      lint([PAIRED], cleanEvaluator),
    ]);

    expect(smellyEvaluator.probabilities.get("src/hash.ts")).toBeGreaterThanOrEqual(0.85);
    expect(smellyJudgments.some(({ probability }) => probability >= 0.85)).toBe(true);
    expect(cleanJudgments.every(({ probability }) => probability < 0.5)).toBe(true);
  });
});
