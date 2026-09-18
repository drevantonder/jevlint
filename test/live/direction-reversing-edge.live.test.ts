import { describe, expect, it } from "vitest";
import { analyzeModules } from "../../src/analyze.js";
import { defaultConfig } from "../../src/config.js";
import { TypeSafeEvaluator } from "../../src/typesafe-evaluator.js";
import type { EvaluationRequest, Evaluator, JevLintConfig, ProjectFile, SourceFile } from "../../src/types.js";

const liveDescribe = process.env.RUN_LIVE_JEV === "1" ? describe : describe.skip;

class RecordingEvaluator implements Evaluator {
  probability: number | undefined;
  readonly delegate = new TypeSafeEvaluator({ apiKey: process.env.JEVLINT_TYPESAFE_API_KEY ?? "" });

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

const reporterBefore = `export function report(lines: string[]) {
  return lines.length;
}
`;

const reporterAfter = `import { summarize } from "../shipping/summary.js";
export function report(lines: string[]) {
  return summarize(lines);
}
`;

function shippingImporter(): string {
  return `import { report } from "../billing/reporter.js";
export function dispatch(lines: string[]) {
  return report(lines);
}
`;
}

liveDescribe("direction reversing edge live judgment", () => {
  it("scores a new edge back against the established area direction", async () => {
    const files = [
      projectFile("billing/reporter.ts", reporterAfter),
      projectFile("billing/core.ts", "export function coreTotal(lines: number[]) {\n  return lines.length;\n}\n"),
      projectFile("billing/helper.ts", "export function helperLabel(value: string) {\n  return value;\n}\n"),
      projectFile("shipping/summary.ts", "export function summarize(lines: string[]) {\n  return lines.join(', ');\n}\n"),
      projectFile("shipping/route-0.ts", shippingImporter()),
      projectFile("shipping/route-1.ts", shippingImporter()),
      ...Array.from({ length: 5 }, (_, index) => projectFile(`extra/widget-${index}.ts`)),
    ];
    const changes: SourceFile[] = [{
      filePath: "billing/reporter.ts",
      source: reporterAfter,
      oldSource: reporterBefore,
      changedLines: [{ start: 1, end: 1 }],
    }];

    const { judgments, probability } = await judge("jev/no-direction-reversing-edge", files, changes);

    expect(judgments).toHaveLength(1);
    expect(judgments[0]?.ruleId).toBe("jev/no-direction-reversing-edge");
    expect(probability).toBeGreaterThanOrEqual(0);
    expect(probability).toBeLessThanOrEqual(1);
  });
});
