import { describe, expect, it } from "vitest";
import { analyzeFile } from "../../src/analyze.js";
import { defaultConfig } from "../../src/config.js";
import { TypeSafeEvaluator } from "../../src/typesafe-evaluator.js";
import type { Evaluator, JevLintConfig, ProjectFile } from "../../src/types.js";

const liveDescribe = process.env.RUN_LIVE_JEV === "1" ? describe : describe.skip;
const RULE = "jev/no-oversized-working-set";

class RecordingEvaluator implements Evaluator {
  readonly probabilities = new Map<string, number>();
  readonly delegate = new TypeSafeEvaluator({ apiKey: process.env.JEVLINT_TYPESAFE_API_KEY ?? "" });
  async evaluate(request: Parameters<Evaluator["evaluate"]>[0]) {
    const answers = await this.delegate.evaluate(request);
    const probability = answers.q0;
    if (probability !== undefined) this.probabilities.set(request.state.file.path, probability);
    return answers;
  }
}

const smelly: ProjectFile[] = [{
  filePath: "src/quote.ts",
  source: `export function quote(order: Order) {
  const items = order.items;
  const currency = order.currency;
  const discount = loadDiscount(order.customer);
  const tax = loadTax(order.region);
  const shipping = loadShipping(order.weight);
  const gift = order.gift ? wrap(order.gift) : null;
  const notes = order.notes ?? "";
  return format(items, currency, discount, tax, shipping, gift, notes);
}
`,
}];

async function lint(projectFiles: ProjectFile[], evaluator: Evaluator) {
  const changed = projectFiles[0];
  const rule = defaultConfig.rules[RULE];
  expect(changed).toBeDefined();
  expect(rule).toBeDefined();
  if (!changed || !rule) return [];
  const config: JevLintConfig = { rules: { [RULE]: rule } };
  return analyzeFile({
    filePath: changed.filePath,
    source: changed.source,
    changedLines: [{ start: 1, end: changed.source.split("\n").length }],
    config,
    projectFiles,
  }, evaluator);
}

liveDescribe("oversized working set calibration", () => {
  it("scores interleaved locals across concerns high", async () => {
    const evaluator = new RecordingEvaluator();
    const judgments = await lint(smelly, evaluator);

    expect(judgments.map(({ ruleId }) => ruleId)).toContain(RULE);
    expect(evaluator.probabilities.get("src/quote.ts")).toBeGreaterThanOrEqual(0.7);
  });
});
