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

function added(filePath: string, source: string): SourceFile {
  return {
    filePath,
    source,
    oldSource: null,
    changedLines: [{ start: 1, end: source.split("\n").length }],
  };
}

function colocated(): ProjectFile[] {
  const files: ProjectFile[] = [];
  const subjects = ["orders", "cart", "pricing", "refund", "ledger", "audit", "notify", "coupon"];
  for (const name of subjects) {
    files.push(projectFile(`src/${name}.ts`, `export function ${name}() { return 1; }\n`));
    files.push(projectFile(
      `src/${name}.test.ts`,
      `import { ${name} } from "./${name}.js";\nexport const check = ${name}();\n`,
    ));
  }
  files.push(projectFile("src/billing.ts", "export function billing() { return 1; }\n"));
  files.push(projectFile("tests/helpers.ts", "export const helper = 1;\n"));
  return files;
}

liveDescribe("far away test live judgment", () => {
  it("scores a distant test against the repo colocation norm", async () => {
    const farTest = 'import { billing } from "../src/billing.js";\nexport const check = billing();\n';
    const files = [...colocated(), projectFile("tests/billing.test.ts", farTest)];

    const { judgments, probability } = await judge(
      "jev/no-far-away-test",
      files,
      [added("tests/billing.test.ts", farTest)],
    );

    expect(judgments).toHaveLength(1);
    expect(judgments[0]?.ruleId).toBe("jev/no-far-away-test");
    expect(probability).toBeGreaterThanOrEqual(0);
    expect(probability).toBeLessThanOrEqual(1);
  });
});
