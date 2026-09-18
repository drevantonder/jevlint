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
  filePath: "src/cart.ts",
  source: `import { t } from "i18next";
export function cartLabel(count: number) {
  return count === 1 ? t("cart.item.one") : t("cart.item.other");
}
`,
}, {
  filePath: "locales/en.json",
  source: `{"cart": {"item": {"one": "item", "other": "items"}}}`,
}, {
  filePath: "src/other.ts",
  source: `import i18next from "i18next";
export function boot() {
  return i18next.language;
}
`,
}];

const live: ProjectFile[] = [{
  filePath: "src/cart-live.ts",
  source: `import { t } from "i18next";
export function cartLabel(count: number) {
  const form = new Intl.PluralRules("en").select(count);
  return t("cart.item", { count, form });
}
`,
}, {
  filePath: "locales/en.json",
  source: `{"cart": {"item": {"one": "item", "other": "items"}}}`,
}];

async function lint(projectFiles: ProjectFile[], evaluator: Evaluator) {
  const changed = projectFiles[0];
  const rule = defaultConfig.rules["jev/no-english-only-pluralization"];
  expect(changed).toBeDefined();
  expect(rule).toBeDefined();
  if (!changed || !rule) return [];
  const config: JevLintConfig = { rules: { "jev/no-english-only-pluralization": rule } };
  return analyzeFile({
    filePath: changed.filePath,
    source: changed.source,
    changedLines: [{ start: 1, end: changed.source.split("\n").length }],
    config,
    projectFiles,
  }, evaluator);
}

liveDescribe("english only pluralization calibration", () => {
  it("flags an English branch over translation keys but keeps plural rules", async () => {
    const smellyEvaluator = new RecordingEvaluator();
    const liveEvaluator = new RecordingEvaluator();
    const [smellyJudgments, liveJudgments] = await Promise.all([
      lint(smelly, smellyEvaluator),
      lint(live, liveEvaluator),
    ]);

    expect(smellyEvaluator.probabilities.get("src/cart.ts")).toBeGreaterThanOrEqual(0.7);
    expect(smellyJudgments.map(({ ruleId }) => ruleId)).toContain(
      "jev/no-english-only-pluralization",
    );
    expect(liveJudgments.every(({ probability }) => probability < 0.7)).toBe(true);
  });
});
