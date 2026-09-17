import { readFile } from "node:fs/promises";
import { describe, expect, it } from "vitest";
import { analyzeFile } from "../../src/analyze.js";
import { defaultConfig } from "../../src/config.js";
import { TypeSafeEvaluator } from "../../src/typesafe-evaluator.js";
import type { EvaluationRequest, Evaluator, JevLintConfig, ProjectFile } from "../../src/types.js";

const liveDescribe = process.env.RUN_LIVE_JEV === "1" ? describe : describe.skip;
const repositories = new URL("../fixtures/repositories/", import.meta.url);

class PassthroughEvaluator implements Evaluator {
  readonly delegate = new TypeSafeEvaluator();
  evaluate(request: EvaluationRequest): Promise<Record<string, number>> {
    return this.delegate.evaluate(request);
  }
}
const evaluator = new PassthroughEvaluator();

async function smelly(): Promise<ProjectFile[]> {
  return Promise.all(
    ["src/billing.ts", "src/reporting.ts", "src/dashboard.ts"].map(async (filePath) => ({
      filePath,
      source: await readFile(new URL(`convergent-twin-smelly/${filePath}`, repositories), "utf8"),
    })),
  );
}

async function distinct(): Promise<ProjectFile[]> {
  return Promise.all(
    ["src/billing.ts", "src/reporting.ts"].map(async (filePath) => ({
      filePath,
      source: await readFile(new URL(`convergent-twin-distinct/${filePath}`, repositories), "utf8"),
    })),
  );
}

async function lint(projectFiles: ProjectFile[]) {
  const changed = projectFiles[0];
  const rule = defaultConfig.rules["jev/no-convergent-twin-types"];
  expect(changed).toBeDefined();
  expect(rule).toBeDefined();
  if (!changed || !rule) return [];
  const config: JevLintConfig = { rules: { "jev/no-convergent-twin-types": rule } };
  return analyzeFile({
    filePath: changed.filePath,
    source: changed.source,
    changedLines: [{ start: 1, end: changed.source.split("\n").length }],
    config,
    projectFiles,
  }, evaluator);
}

liveDescribe("convergent twin types with structural evidence", () => {
  it("flags the identical DTO twin but keeps distinct shapes", async () => {
    const [smellyFiles, distinctFiles] = await Promise.all([smelly(), distinct()]);
    const [smellyJudgments, distinctJudgments] = await Promise.all([
      lint(smellyFiles),
      lint(distinctFiles),
    ]);

    expect(smellyJudgments.length).toBeGreaterThan(0);
    expect(smellyJudgments.every(({ probability }) => probability >= 0.5)).toBe(true);
    expect(distinctJudgments.length).toBe(0);
  });
});
