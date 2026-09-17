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

const ENTRY: ProjectFile = {
  filePath: "src/entry.ts",
  source: "import { handle } from \"./mid.js\";\n"
    + "export function serve(request: { url: string; valid: boolean }): unknown {\n"
    + "  return handle(request);\n"
    + "}\n",
};
const MID: ProjectFile = {
  filePath: "src/mid.ts",
  source: "import { enforce } from \"./policy.js\";\n"
    + "export function handle(request: { url: string; valid: boolean }): unknown {\n"
    + "  return enforce(request);\n"
    + "}\n",
};
const POLICY: ProjectFile = {
  filePath: "src/policy.ts",
  source: "export function enforce(request: { url: string; valid: boolean }): unknown {\n"
    + "  if (!request.valid) throw new Error(\"invalid\");\n"
    + "  return { ok: true };\n"
    + "}\n",
};
const SELF_CONTAINED: ProjectFile = {
  filePath: "src/entry.ts",
  source: "export function serve(request: { url: string; valid: boolean }): unknown {\n"
    + "  if (!request.valid) throw new Error(\"invalid\");\n"
    + "  return { ok: true };\n"
    + "}\n",
};

async function lint(projectFiles: ProjectFile[], evaluator: Evaluator) {
  const changed = projectFiles.find(({ filePath }) => filePath === "src/entry.ts");
  const rule = defaultConfig.rules["jev/no-deep-delegation-chain"];
  expect(changed).toBeDefined();
  expect(rule).toBeDefined();
  if (!changed || !rule) return [];
  const config: JevLintConfig = { rules: { "jev/no-deep-delegation-chain": rule } };
  return analyzeFile({
    filePath: changed.filePath,
    source: changed.source,
    changedLines: [{ start: 1, end: changed.source.split("\n").length }],
    config,
    projectFiles,
  }, evaluator);
}

liveDescribe("deep delegation chain live judgment", () => {
  it("scores a forwarding middle hop into a policy terminal above a local handler", async () => {
    const chainedEvaluator = new RecordingEvaluator();
    const localEvaluator = new RecordingEvaluator();
    const [chainedJudgments, localJudgments] = await Promise.all([
      lint([ENTRY, MID, POLICY], chainedEvaluator),
      lint([SELF_CONTAINED], localEvaluator),
    ]);

    expect(chainedEvaluator.probabilities.get("src/entry.ts")).toBeGreaterThanOrEqual(0.85);
    expect(chainedJudgments.some(({ probability }) => probability >= 0.85)).toBe(true);
    expect(localJudgments.every(({ probability }) => probability < 0.5)).toBe(true);
  });
});
