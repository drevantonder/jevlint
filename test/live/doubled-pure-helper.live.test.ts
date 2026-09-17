import { readFile } from "node:fs/promises";
import { describe, expect, it } from "vitest";
import { analyzeFile } from "../../src/analyze.js";
import { defaultConfig } from "../../src/config.js";
import { TypeSafeEvaluator } from "../../src/typesafe-evaluator.js";
import type { Evaluator, JevLintConfig, ProjectFile } from "../../src/types.js";

const liveDescribe = process.env.RUN_LIVE_JEV === "1" ? describe : describe.skip;
const repositories = new URL("../fixtures/repositories/", import.meta.url);

async function project(name: string, paths: string[]): Promise<ProjectFile[]> {
  return Promise.all(paths.map(async (filePath) => ({
    filePath,
    source: await readFile(new URL(`${name}/${filePath}`, repositories), "utf8"),
  })));
}

async function lint(projectFiles: ProjectFile[], filePath: string, evaluator: Evaluator) {
  const changed = projectFiles.find((file) => file.filePath === filePath);
  const rule = defaultConfig.rules["jev/no-doubled-pure-helper"];
  expect(changed).toBeDefined();
  expect(rule).toBeDefined();
  if (!changed || !rule) return [];
  const config: JevLintConfig = { rules: { "jev/no-doubled-pure-helper": rule } };
  return analyzeFile({
    filePath,
    source: changed.source,
    changedLines: [{ start: 1, end: changed.source.split("\n").length }],
    config,
    projectFiles,
  }, evaluator);
}

liveDescribe("doubled pure helper with purity evidence", () => {
  it("judges a doubled pure helper but abstains on a mock-free test", async () => {
    const [doubled, plain] = await Promise.all([
      project("doubled-helper", ["test/slug.test.ts", "src/slug.ts", "src/cart.ts"]),
      project("mock-negative", ["test/report.test.ts", "src/report.ts", "src/network.ts"]),
    ]);

    const [doubledJudgments, plainJudgments] = await Promise.all([
      lint(doubled, "test/slug.test.ts", new TypeSafeEvaluator()),
      lint(plain, "test/report.test.ts", new TypeSafeEvaluator()),
    ]);

    expect(doubledJudgments.length).toBeGreaterThan(0);
    expect(doubledJudgments[0]?.ruleId).toBe("jev/no-doubled-pure-helper");
    expect(plainJudgments).toEqual([]);
  });
});
