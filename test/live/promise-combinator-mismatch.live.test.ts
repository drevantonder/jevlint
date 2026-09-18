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
const combinatorEvidenceSchema = z.object({
  function: z.object({ name: z.string() }).passthrough(),
}).passthrough();

class RecordingEvaluator implements Evaluator {
  readonly probabilities = new Map<string, number>();
  readonly delegate = new TypeSafeEvaluator({ apiKey: process.env.TYPESAFE_API_KEY ?? "" });

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
      const evidence = combinatorEvidenceSchema.safeParse(
        candidate?.evidence?.["jev/no-promise-combinator-mismatch"],
      );
      if (evidence.success) this.probabilities.set(evidence.data.function.name, probability);
    }
    return answers;
  }
}

const smelly: ProjectFile[] = [{
  filePath: "src/orders.ts",
  source: `export async function syncProviders(order: { id: string }) {
  const [stock, billing, shipping] = await Promise.all([
    reserveStock(order.id),
    chargeCard(order.id),
    bookShipment(order.id),
  ]);
  return { stock, billing, shipping };
}
`,
}];

const clean: ProjectFile[] = [{
  filePath: "src/dashboard.ts",
  source: `export async function loadDashboard(userId: string, adminId: string) {
  const [profile, settings] = await Promise.all([fetchUser(userId), fetchUser(adminId)]);
  return { profile, settings };
}
`,
}];

async function lintChangedFile(projectFiles: ProjectFile[], evaluator: Evaluator) {
  const changed = projectFiles[0];
  expect(changed).toBeDefined();
  if (!changed) return [];
  const rule = defaultConfig.rules["jev/no-promise-combinator-mismatch"];
  expect(rule).toBeDefined();
  if (!rule) return [];
  const config: JevLintConfig = { rules: { "jev/no-promise-combinator-mismatch": rule } };
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

liveDescribe("promise combinator mismatch with repository evidence", () => {
  it("separates heterogeneous provider writes from homogeneous tuple reads", async () => {
    const evaluator = new RecordingEvaluator();
    const [smellyJudgments, cleanJudgments] = await Promise.all([
      lintChangedFile(smelly, evaluator),
      lintChangedFile(clean, evaluator),
    ]);

    expect(evaluator.probabilities.get("syncProviders")).toBeGreaterThanOrEqual(0.7);
    expect(evaluator.probabilities.get("loadDashboard")).toBeLessThan(0.6);
    expect(smellyJudgments.map(({ ruleId }) => ruleId)).toContain("jev/no-promise-combinator-mismatch");
    expect(cleanJudgments.every(({ probability }) => probability < 0.6)).toBe(true);
  });
});
