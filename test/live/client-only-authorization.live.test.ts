import { describe, expect, it } from "vitest";
import { analyzeFile } from "../../src/analyze.js";
import { defaultConfig } from "../../src/config.js";
import { TypeSafeEvaluator } from "../../src/typesafe-evaluator.js";
import type { EvaluationRequest, Evaluator, JevLintConfig, ProjectFile } from "../../src/types.js";

const liveDescribe = process.env.RUN_LIVE_JEV === "1" ? describe : describe.skip;
const ruleId = "jev/no-client-only-authorization";

const positive: ProjectFile[] = [
  {
    filePath: "src/routes.ts",
    source: `export function billingRoute(user: { isAdmin: boolean }) {
  if (!user.isAdmin) {
    redirect("/login");
  }
  return loadBilling();
}
`,
  },
  {
    filePath: "src/billing.ts",
    source: `export function loadBilling() {
  return db.billing.all();
}
`,
  },
];

const negative: ProjectFile[] = [
  {
    filePath: "src/routes.ts",
    source: `import { getServerSession } from "./auth";
export function billingRoute(user: { isAdmin: boolean }) {
  if (!user.isAdmin) {
    redirect("/login");
  }
  return loadBilling();
}
export async function loadBilling(req: unknown) {
  const session = await getServerSession(req);
  if (session.role !== "admin") throw new Error("forbidden");
  return db.billing.all();
}
`,
  },
];

class RecordingEvaluator implements Evaluator {
  probability: number | undefined;
  readonly delegate = new TypeSafeEvaluator({ apiKey: process.env.JEVLINT_TYPESAFE_API_KEY ?? "" });

  async evaluate(request: EvaluationRequest): Promise<Record<string, number>> {
    const answers = await this.delegate.evaluate(request);
    this.probability = answers.q0;
    return answers;
  }
}

async function calibrate(projectFiles: ProjectFile[]) {
  const changed = projectFiles[0];
  const rule = defaultConfig.rules[ruleId];
  expect(changed).toBeDefined();
  expect(rule).toBeDefined();
  if (!changed || !rule) return { judgments: [], probability: undefined };
  const config: JevLintConfig = { rules: { [ruleId]: rule } };
  const evaluator = new RecordingEvaluator();
  const judgments = await analyzeFile({
    filePath: changed.filePath,
    source: changed.source,
    changedLines: [{ start: 1, end: changed.source.split("\n").length }],
    config,
    projectFiles,
  }, evaluator);
  return { judgments, probability: evaluator.probability };
}

liveDescribe("client-only authorization calibration", () => {
  it("scores the bare endpoint above the server-guarded one", async () => {
    const [bare, guarded] = await Promise.all([calibrate(positive), calibrate(negative)]);

    if (bare.probability === undefined || guarded.probability === undefined) {
      throw new Error("live calibration produced no probability");
    }
    expect(bare.probability).toBeGreaterThan(guarded.probability);
    expect(bare.judgments.map(({ ruleId: id }) => id)).toEqual([ruleId]);
  });
});
