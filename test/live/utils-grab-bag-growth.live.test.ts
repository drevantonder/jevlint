import { describe, expect, it } from "vitest";
import { analyzeModules } from "../../src/analyze.js";
import { defaultConfig } from "../../src/config.js";
import { TypeSafeEvaluator } from "../../src/typesafe-evaluator.js";
import type { EvaluationRequest, Evaluator, JevLintConfig, ProjectFile, SourceFile } from "../../src/types.js";

const liveDescribe = process.env.RUN_LIVE_JEV === "1" ? describe : describe.skip;

class RecordingEvaluator implements Evaluator {
  probability: number | undefined;
  readonly delegate = new TypeSafeEvaluator();

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

const beforeUtils = `export function formatDate(value: Date) {
  return value.toISOString();
}
export function hashToken(token: string) {
  return token.length;
}
export function capitalizeName(name: string) {
  return name.toUpperCase();
}
`;

const afterUtils = `${beforeUtils}export function calculateInvoiceTax(amount: number) {
  return amount * 0.2;
}
`;

liveDescribe("utils grab bag growth live judgment", () => {
  it("scores an unrelated export added to a miscellaneous module", async () => {
    const files = [
      ...Array.from({ length: 10 }, (_, index) => projectFile(`src/filler-${index}.ts`)),
      projectFile("src/utils.ts", afterUtils),
      projectFile(
        "src/billing.ts",
        'import { calculateInvoiceTax } from "./utils.js";\nexport const tax = calculateInvoiceTax(1);\n',
      ),
    ];
    const changes: SourceFile[] = [{
      filePath: "src/utils.ts",
      source: afterUtils,
      oldSource: beforeUtils,
      changedLines: [{ start: 10, end: 12 }],
    }];

    const { judgments, probability } = await judge("jev/no-utils-grab-bag-growth", files, changes);

    expect(judgments).toHaveLength(1);
    expect(judgments[0]?.ruleId).toBe("jev/no-utils-grab-bag-growth");
    expect(probability).toBeGreaterThanOrEqual(0);
    expect(probability).toBeLessThanOrEqual(1);
  });
});
