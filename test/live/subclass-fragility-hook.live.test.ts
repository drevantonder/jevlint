import { describe, expect, it } from "vitest";
import { analyzeFile } from "../../src/analyze.js";
import { defaultConfig } from "../../src/config.js";
import { TypeSafeEvaluator } from "../../src/typesafe-evaluator.js";
import type {
  EvaluationRequest,
  Evaluator,
  JevLintConfig,
  ProjectFile,
} from "../../src/types.js";

const liveDescribe = process.env.RUN_LIVE_JEV === "1" ? describe : describe.skip;

class PassthroughEvaluator implements Evaluator {
  readonly delegate = new TypeSafeEvaluator({ apiKey: process.env.TYPESAFE_API_KEY ?? "" });
  evaluate(request: EvaluationRequest): Promise<Record<string, number>> {
    return this.delegate.evaluate(request);
  }
}

const base: ProjectFile = {
  filePath: "src/base.ts",
  source: "export type Row = { value: string };\n"
    + "export class ReportBuilder {\n"
    + "  build(rows: Row[]): string {\n"
    + "    const header = this.header();\n"
    + "    const lines = rows.map((row) => this.format(row));\n"
    + "    const withTotals = this.appendTotals(lines);\n"
    + "    const footer = this.footer();\n"
    + "    return [header, ...withTotals, footer].join(\"\\n\");\n"
    + "  }\n"
    + "  header(): string {\n"
    + "    return \"report\";\n"
    + "  }\n"
    + "  format(row: Row): string {\n"
    + "    return row.value;\n"
    + "  }\n"
    + "  appendTotals(lines: string[]): string[] {\n"
    + "    return [...lines, `total: ${lines.length}`];\n"
    + "  }\n"
    + "  footer(): string {\n"
    + "    return \"end\";\n"
    + "  }\n"
    + "}\n",
};

const copied = "import { ReportBuilder, Row } from \"./base\";\n"
  + "export class CsvReportBuilder extends ReportBuilder {\n"
  + "  build(rows: Row[]): string {\n"
  + "    const header = this.header();\n"
  + "    const lines = rows.map((row) => this.format(row));\n"
  + "    const withTotals = this.appendTotals(lines);\n"
  + "    const footer = this.footer();\n"
  + "    return [header, ...withTotals, footer].join(\",\");\n"
  + "  }\n"
  + "}\n";

const delegating = "import { ReportBuilder, Row } from \"./base\";\n"
  + "export class UpperReportBuilder extends ReportBuilder {\n"
  + "  build(rows: Row[]): string {\n"
  + "    return super.build(rows).toUpperCase();\n"
  + "  }\n"
  + "}\n";

async function lint(source: string, evaluator: Evaluator) {
  const rule = defaultConfig.rules["jev/no-subclass-fragility-hook"];
  expect(rule).toBeDefined();
  if (!rule) return [];
  const config: JevLintConfig = { rules: { "jev/no-subclass-fragility-hook": rule } };
  return analyzeFile({
    filePath: "src/csv.ts",
    source,
    changedLines: [{ start: 1, end: source.split("\n").length }],
    config,
    projectFiles: [
      { filePath: "src/csv.ts", source },
      base,
    ],
  }, evaluator);
}

liveDescribe("subclass fragility hook calibration", () => {
  it("flags a copied override but keeps a super-delegating one low", async () => {
    const [copiedJudgments, delegatingJudgments] = await Promise.all([
      lint(copied, new PassthroughEvaluator()),
      lint(delegating, new PassthroughEvaluator()),
    ]);

    expect(copiedJudgments.map(({ ruleId }) => ruleId)).toContain(
      "jev/no-subclass-fragility-hook",
    );
    expect(delegatingJudgments.every(({ probability }) => probability < 0.6)).toBe(true);
  });
});
