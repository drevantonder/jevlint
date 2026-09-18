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

const SMELLY: ProjectFile = {
  filePath: "src/secrets.ts",
  source: "export function encrypt(data: string, key: string): string {\n"
    + "  let out = \"\";\n"
    + "  for (let index = 0; index < data.length; index += 1) {\n"
    + "    const mixed = data.charCodeAt(index) ^ key.charCodeAt(index % key.length);\n"
    + "    out += String.fromCharCode((mixed << 3) | (mixed >> 5));\n"
    + "  }\n"
    + "  return out;\n"
    + "}\n"
    + "export function storeCredential(user: string, password: string): void {\n"
    + "  save(user, encrypt(password, user));\n"
    + "}\n",
};
const PAIRED: ProjectFile = {
  filePath: "src/secrets.ts",
  source: "export function shardKey(key: string): number {\n"
    + "  let hash = 0;\n"
    + "  for (let index = 0; index < key.length; index += 1) {\n"
    + "    hash = (hash << 5) | (hash >> 2);\n"
    + "    hash += key.charCodeAt(index);\n"
    + "  }\n"
    + "  return hash;\n"
    + "}\n",
};

async function lint(projectFiles: ProjectFile[], evaluator: Evaluator) {
  const changed = projectFiles.find(({ filePath }) => filePath === "src/secrets.ts");
  const rule = defaultConfig.rules["jev/no-bespoke-crypto-construction"];
  expect(changed).toBeDefined();
  expect(rule).toBeDefined();
  if (!changed || !rule) return [];
  const config: JevLintConfig = { rules: { "jev/no-bespoke-crypto-construction": rule } };
  return analyzeFile({
    filePath: changed.filePath,
    source: changed.source,
    changedLines: [{ start: 1, end: changed.source.split("\n").length }],
    config,
    projectFiles,
  }, evaluator);
}

liveDescribe("bespoke crypto construction with structural evidence", () => {
  it("flags a hand-rolled cipher but keeps a sharding hash", async () => {
    const smellyEvaluator = new RecordingEvaluator();
    const cleanEvaluator = new RecordingEvaluator();
    const [smellyJudgments, cleanJudgments] = await Promise.all([
      lint([SMELLY], smellyEvaluator),
      lint([PAIRED], cleanEvaluator),
    ]);

    expect(smellyEvaluator.probabilities.get("src/secrets.ts")).toBeGreaterThanOrEqual(0.85);
    expect(smellyJudgments.some(({ probability }) => probability >= 0.85)).toBe(true);
    expect(cleanJudgments.every(({ probability }) => probability < 0.5)).toBe(true);
  });
});
