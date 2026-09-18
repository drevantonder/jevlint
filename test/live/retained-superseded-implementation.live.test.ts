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
  const rule = defaultConfig.rules["jev/no-retained-superseded-implementation"];
  expect(changed).toBeDefined();
  expect(rule).toBeDefined();
  if (!changed || !rule) return [];
  const config: JevLintConfig = { rules: { "jev/no-retained-superseded-implementation": rule } };
  return analyzeFile({
    filePath,
    source: changed.source,
    changedLines: [{ start: 1, end: changed.source.split("\n").length }],
    config,
    projectFiles,
  }, evaluator);
}

liveDescribe("retained superseded implementation with marker evidence", () => {
  it("judges a callerless marked implementation but abstains on its live successor", async () => {
    const projectFiles = await project("superseded-retained", [
      "src/legacy.ts",
      "src/format.ts",
    ]);

    const [retained, successor] = await Promise.all([
      lint(projectFiles, "src/legacy.ts", new TypeSafeEvaluator({ apiKey: process.env.JEVLINT_TYPESAFE_API_KEY ?? "" })),
      lint(projectFiles, "src/format.ts", new TypeSafeEvaluator({ apiKey: process.env.JEVLINT_TYPESAFE_API_KEY ?? "" })),
    ]);

    expect(retained.length).toBeGreaterThan(0);
    expect(retained[0]?.ruleId).toBe("jev/no-retained-superseded-implementation");
    expect(successor).toEqual([]);
  });
});
