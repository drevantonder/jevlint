import { describe, expect, it } from "vitest";
import { analyzeModules } from "../../src/analyze.js";
import { defaultConfig } from "../../src/config.js";
import { TypeSafeEvaluator } from "../../src/typesafe-evaluator.js";
import type { EvaluationRequest, Evaluator, JevLintConfig, ProjectFile, SourceFile } from "../../src/types.js";

const liveDescribe = process.env.RUN_LIVE_JEV === "1" ? describe : describe.skip;

class RecordingEvaluator implements Evaluator {
  probability: number | undefined;
  readonly delegate = new TypeSafeEvaluator({ apiKey: process.env.TYPESAFE_API_KEY ?? "" });

  async evaluate(request: EvaluationRequest): Promise<Record<string, number>> {
    const answers = await this.delegate.evaluate(request);
    this.probability = answers.q0;
    return answers;
  }
}

function projectFile(filePath: string, source = "export const value = 1;\n"): ProjectFile {
  return { filePath, source };
}

async function judge(ruleId: string, files: ProjectFile[], changes: SourceFile[]) {
  const rule = defaultConfig.rules[ruleId];
  expect(rule).toBeDefined();
  if (!rule) return { judgments: [], probability: undefined };
  const config: JevLintConfig = { rules: { [ruleId]: rule } };
  const evaluator = new RecordingEvaluator();
  const judgments = await analyzeModules({ changes, config, projectFiles: files }, evaluator);
  return { judgments, probability: evaluator.probability };
}

const calc = `export function calculateTotal(items: number[]) {
  return items.reduce((total, item) => total + item, 0);
}
`;

const shipBefore = `export function ship(order: string) {
  return order;
}
`;

const shipAfter = `import { calculateTotal } from "../../billing/src/calc.js";
export function ship(order: string) {
  return String(calculateTotal([1])) + order;
}
`;

liveDescribe("cross service source reach live judgment", () => {
  it("scores a new relative reach across a manifest boundary", async () => {
    const files = [
      projectFile("services/billing/src/calc.ts", calc),
      projectFile("services/billing/src/index.ts", `export { calculateTotal } from "./calc.js";\n`),
      projectFile("services/shipping/src/ship.ts", shipAfter),
      projectFile("package.json", JSON.stringify({ name: "acme-root", workspaces: ["services/*"] })),
      projectFile("services/billing/package.json", JSON.stringify({ name: "@acme/billing" })),
      projectFile("services/shipping/package.json", JSON.stringify({ name: "@acme/shipping" })),
      ...Array.from({ length: 7 }, (_, index) => projectFile(`services/extra/widget-${index}.ts`)),
    ];
    const changes: SourceFile[] = [{
      filePath: "services/shipping/src/ship.ts",
      source: shipAfter,
      oldSource: shipBefore,
      changedLines: [{ start: 1, end: 1 }],
    }];

    const { judgments, probability } = await judge("jev/no-cross-service-source-reach", files, changes);

    expect(judgments).toHaveLength(1);
    expect(judgments[0]?.ruleId).toBe("jev/no-cross-service-source-reach");
    expect(probability).toBeGreaterThanOrEqual(0);
    expect(probability).toBeLessThanOrEqual(1);
  });
});
