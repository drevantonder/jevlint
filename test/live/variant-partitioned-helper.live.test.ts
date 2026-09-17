import { describe, expect, it } from "vitest";
import { analyzeFile } from "../../src/analyze.js";
import { defaultConfig } from "../../src/config.js";
import { TypeSafeEvaluator } from "../../src/typesafe-evaluator.js";
import type { JevLintConfig, ProjectFile } from "../../src/types.js";

const liveDescribe = process.env.RUN_LIVE_JEV === "1" ? describe : describe.skip;
const evaluator = new TypeSafeEvaluator();

const reportSource = `export function renderReport(format: string, rows: string[]): string {
  if (format === "json") {
    const body = JSON.stringify(rows);
    return body.toUpperCase();
  }
  if (format === "csv") {
    const header = "rows\\n";
    return header + rows.join("\\n");
  }
  throw new Error("unknown format " + format);
}
`;

const pageSource = `import { renderReport } from "./report.js";

export function jsonPage(rows: string[]): string {
  return renderReport("json", rows);
}

export function csvPage(rows: string[]): string {
  return renderReport("csv", rows);
}
`;

const greetSource = `export function greet(name: string): string {
  return "hello " + name;
}
`;

async function lint(source: string, projectFiles: ProjectFile[]) {
  const rule = defaultConfig.rules["jev/no-variant-partitioned-helper"];
  expect(rule).toBeDefined();
  if (!rule) return [];
  const config: JevLintConfig = { rules: { "jev/no-variant-partitioned-helper": rule } };
  return analyzeFile({
    filePath: "src/report.ts",
    source,
    changedLines: [{ start: 1, end: source.split("\n").length }],
    config,
    projectFiles,
  }, evaluator);
}

liveDescribe("variant partitioned helper with structural evidence", () => {
  it("judges a variant-partitioned helper but abstains without one", async () => {
    const smelly: ProjectFile[] = [
      { filePath: "src/report.ts", source: reportSource },
      { filePath: "src/page.ts", source: pageSource },
    ];
    const clean: ProjectFile[] = [{ filePath: "src/report.ts", source: greetSource }];

    const [smellyJudgments, cleanJudgments] = await Promise.all([
      lint(reportSource, smelly),
      lint(greetSource, clean),
    ]);

    expect(smellyJudgments).toHaveLength(1);
    expect(smellyJudgments[0]?.probability).toBeGreaterThanOrEqual(0);
    expect(smellyJudgments[0]?.probability).toBeLessThanOrEqual(1);
    expect(cleanJudgments).toHaveLength(0);
  });
});
