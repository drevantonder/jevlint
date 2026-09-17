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

const formBefore = `import { useState } from "react";
export function Form() {
  return useState(null);
}
`;

const formAfter = `import { useState } from "react";
import { Button } from "../../shared/ui/button.js";
export function Form() {
  return [useState(null), Button()];
}
`;

liveDescribe("skipped level import live judgment", () => {
  it("scores a multi-level climb past a nearer barrel", async () => {
    const files = [
      projectFile("features/billing/form.ts", formAfter),
      projectFile("features/billing/summary.ts", "export const summary = 1;\n"),
      projectFile("shared/ui/button.ts", 'export function Button() {\n  return "button";\n}\n'),
      projectFile("shared/ui/input.ts", "export const input = 1;\n"),
      projectFile("shared/index.ts", 'export { Button } from "./ui/button.js";\n'),
      ...Array.from({ length: 7 }, (_, index) => projectFile(`features/extra/widget-${index}.ts`)),
    ];
    const changes: SourceFile[] = [{
      filePath: "features/billing/form.ts",
      source: formAfter,
      oldSource: formBefore,
      changedLines: [{ start: 2, end: 2 }],
    }];

    const { judgments, probability } = await judge("jev/no-skipped-level-import", files, changes);

    expect(judgments).toHaveLength(1);
    expect(judgments[0]?.ruleId).toBe("jev/no-skipped-level-import");
    expect(probability).toBeGreaterThanOrEqual(0);
    expect(probability).toBeLessThanOrEqual(1);
  });
});
