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

const smelly: ProjectFile[] = [{
  filePath: "src/summary.tsx",
  source: `export function CheckoutSummary({ count }: { count: number }) {
  return (
    <div>
      <p>Order complete</p>
      <span>{count === 1 ? "item" : "items"}</span>
    </div>
  );
}
`,
}, {
  filePath: "src/i18n.ts",
  source: `import i18next from "i18next";
export const locale = i18next.language;
`,
}];

const translated: ProjectFile[] = [{
  filePath: "src/summary-clean.tsx",
  source: `import { useTranslation } from "react-i18next";
export function CheckoutSummaryClean() {
  const { t } = useTranslation();
  return <p>{t("order.complete")}</p>;
}
`,
}];

async function lint(projectFiles: ProjectFile[], evaluator: Evaluator) {
  const changed = projectFiles[0];
  const rule = defaultConfig.rules["jev/no-unlocalized-user-string"];
  expect(changed).toBeDefined();
  expect(rule).toBeDefined();
  if (!changed || !rule) return [];
  const config: JevLintConfig = { rules: { "jev/no-unlocalized-user-string": rule } };
  return analyzeFile({
    filePath: changed.filePath,
    source: changed.source,
    changedLines: [{ start: 1, end: changed.source.split("\n").length }],
    config,
    projectFiles,
  }, evaluator);
}

liveDescribe("unlocalized user string with structural evidence", () => {
  it("flags baked-in copy but keeps translated copy", async () => {
    const smellyEvaluator = new RecordingEvaluator();
    const translatedEvaluator = new RecordingEvaluator();
    const [smellyJudgments, translatedJudgments] = await Promise.all([
      lint(smelly, smellyEvaluator),
      lint(translated, translatedEvaluator),
    ]);

    expect(smellyEvaluator.probabilities.get("src/summary.tsx")).toBeGreaterThanOrEqual(0.7);
    expect(smellyJudgments.map(({ ruleId }) => ruleId)).toContain("jev/no-unlocalized-user-string");
    expect(translatedJudgments.every(({ probability }) => probability < 0.7)).toBe(true);
  });
});
