import { describe, expect, it } from "vitest";
import { analyzeFile } from "../../src/analyze.js";
import { defaultConfig } from "../../src/config.js";
import { TypeSafeEvaluator } from "../../src/typesafe-evaluator.js";
import type { EvaluationRequest, Evaluator, JevLintConfig, ProjectFile } from "../../src/types.js";

const liveDescribe = process.env.RUN_LIVE_JEV === "1" ? describe : describe.skip;
const ruleId = "jev/no-unpinned-boundary-branch";

const positive: ProjectFile[] = [
  {
    filePath: "src/discount.ts",
    source: `export function discountFor(tier: string, amount: number) {
  if (tier === "gold" && amount > 1000) {
    return amount * 0.85;
  }
  return amount;
}
`,
  },
  {
    filePath: "src/checkout.ts",
    source: `import { discountFor } from "./discount";
export function checkout(tier: string, amount: number) {
  return discountFor(tier, amount);
}
`,
  },
];

const negative: ProjectFile[] = [
  {
    filePath: "src/discount.ts",
    source: `export function discountFor(tier: string, amount: number) {
  if (tier === "gold" && amount > 1000) {
    return amount * 0.85;
  }
  return amount;
}
`,
  },
  {
    filePath: "src/discount.test.ts",
    source: `import { discountFor } from "./discount";
import { describe, expect, it } from "vitest";
describe("discountFor", () => {
  it("pins both sides of the boundary", () => {
    expect(discountFor("gold", 1001)).toBe(850.85);
    expect(discountFor("gold", 1000)).toBe(1000);
  });
});
`,
  },
];

class RecordingEvaluator implements Evaluator {
  probability: number | undefined;
  readonly delegate = new TypeSafeEvaluator({ apiKey: process.env.TYPESAFE_API_KEY ?? "" });

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

liveDescribe("unpinned boundary branch calibration", () => {
  it("scores the unpinned boundary above the pinned one", async () => {
    const [unpinned, pinned] = await Promise.all([calibrate(positive), calibrate(negative)]);

    if (unpinned.probability === undefined || pinned.probability === undefined) {
      throw new Error("live calibration produced no probability");
    }
    expect(unpinned.probability).toBeGreaterThan(pinned.probability);
    expect(unpinned.judgments.map(({ ruleId: id }) => id)).toEqual([ruleId]);
  });
});
