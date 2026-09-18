import { describe, expect, it } from "vitest";
import { z } from "zod";
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
const questionInstructionsSchema = z.object({ inspect: z.string() }).passthrough();
const tlsEvidenceSchema = z.object({
  function: z.object({ name: z.string() }).passthrough(),
}).passthrough();

class RecordingEvaluator implements Evaluator {
  readonly probabilities = new Map<string, number>();
  readonly delegate = new TypeSafeEvaluator({ apiKey: process.env.JEVLINT_TYPESAFE_API_KEY ?? "" });

  async evaluate(request: EvaluationRequest): Promise<Record<string, number>> {
    const answers = await this.delegate.evaluate(request);
    for (const [questionId, probability] of Object.entries(answers)) {
      const instructions = questionInstructionsSchema.safeParse(
        request.questions[questionId]?.instructions,
      );
      if (!instructions.success) continue;
      const match = /candidates\[(\d+)]/.exec(instructions.data.inspect);
      const candidate = match?.[1] === undefined
        ? undefined
        : request.state.candidates[Number(match[1])];
      const evidence = tlsEvidenceSchema.safeParse(
        candidate?.evidence?.["jev/no-disabled-tls-verification"],
      );
      if (evidence.success) this.probabilities.set(evidence.data.function.name, probability);
    }
    return answers;
  }
}

const smelly: ProjectFile[] = [{
  filePath: "src/payments.ts",
  source: `import https from "node:https";
export function chargeCard(payload: { amount: number }) {
  const agent = new https.Agent({ rejectUnauthorized: false });
  return https.request("https://pay.example", { agent });
}
`,
}];

const clean: ProjectFile[] = [{
  filePath: "test/payments.test.ts",
  source: `import https from "node:https";
export function chargeCard(payload: { amount: number }) {
  const agent = new https.Agent({ rejectUnauthorized: false });
  return https.request("https://pay.example", { agent });
}
`,
}];

async function lintChangedFile(projectFiles: ProjectFile[], evaluator: Evaluator) {
  const changed = projectFiles[0];
  expect(changed).toBeDefined();
  if (!changed) return [];
  const rule = defaultConfig.rules["jev/no-disabled-tls-verification"];
  expect(rule).toBeDefined();
  if (!rule) return [];
  const config: JevLintConfig = { rules: { "jev/no-disabled-tls-verification": rule } };
  return analyzeFile(
    {
      filePath: changed.filePath,
      source: changed.source,
      changedLines: [{ start: 1, end: changed.source.split("\n").length }],
      config,
      projectFiles,
    },
    evaluator,
  );
}

liveDescribe("disabled TLS verification with repository evidence", () => {
  it("separates a production bypass from a test-harness flag", async () => {
    const smellyEvaluator = new RecordingEvaluator();
    const cleanEvaluator = new RecordingEvaluator();
    const [smellyJudgments, cleanJudgments] = await Promise.all([
      lintChangedFile(smelly, smellyEvaluator),
      lintChangedFile(clean, cleanEvaluator),
    ]);

    expect(smellyEvaluator.probabilities.get("chargeCard")).toBeGreaterThanOrEqual(0.7);
    expect(smellyJudgments.map(({ ruleId }) => ruleId)).toContain("jev/no-disabled-tls-verification");
    expect(cleanJudgments.every(({ probability }) => probability < 0.7)).toBe(true);
  });
});
