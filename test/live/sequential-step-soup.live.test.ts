import { describe, expect, it } from "vitest";
import { analyzeFile } from "../../src/analyze.js";
import { defaultConfig } from "../../src/config.js";
import { TypeSafeEvaluator } from "../../src/typesafe-evaluator.js";
import type { JevLintConfig, ProjectFile } from "../../src/types.js";

const liveDescribe = process.env.RUN_LIVE_JEV === "1" ? describe : describe.skip;
const evaluator = new TypeSafeEvaluator();

const soupSource = `export function runJob(config: Config): void {
  const errors = validateConfig(config);
  if (errors.length > 0) throw new Error(errors.join(","));

  const started = Date.now();
  emitMetric("job.start", started);
  notifyWatchers(config.id);

  const output = renderReport(config);
  writeFileSync(config.outPath, output);
  markComplete(config.id);
}
`;

const pipelineSource = `export function greet(name: string): string {
  const trimmed = name.trim();

  return "hello " + trimmed;
}
`;

async function lint(source: string, projectFiles: ProjectFile[]) {
  const rule = defaultConfig.rules["jev/no-sequential-step-soup"];
  expect(rule).toBeDefined();
  if (!rule) return [];
  const config: JevLintConfig = { rules: { "jev/no-sequential-step-soup": rule } };
  return analyzeFile({
    filePath: "src/job.ts",
    source,
    changedLines: [{ start: 1, end: source.split("\n").length }],
    config,
    projectFiles,
  }, evaluator);
}

liveDescribe("sequential step soup with structural evidence", () => {
  it("judges disjoint phases but abstains on a short sequence", async () => {
    const smelly: ProjectFile[] = [{ filePath: "src/job.ts", source: soupSource }];
    const clean: ProjectFile[] = [{ filePath: "src/job.ts", source: pipelineSource }];

    const [smellyJudgments, cleanJudgments] = await Promise.all([
      lint(soupSource, smelly),
      lint(pipelineSource, clean),
    ]);

    expect(smellyJudgments).toHaveLength(1);
    expect(smellyJudgments[0]?.probability).toBeGreaterThanOrEqual(0);
    expect(smellyJudgments[0]?.probability).toBeLessThanOrEqual(1);
    expect(cleanJudgments).toHaveLength(0);
  });
});
