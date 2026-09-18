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
  const rule = defaultConfig.rules["jev/no-impossible-error-branch"];
  expect(changed).toBeDefined();
  expect(rule).toBeDefined();
  if (!changed || !rule) return [];
  const config: JevLintConfig = { rules: { "jev/no-impossible-error-branch": rule } };
  return analyzeFile({
    filePath,
    source: changed.source,
    changedLines: [{ start: 1, end: changed.source.split("\n").length }],
    config,
    projectFiles,
  }, evaluator);
}

liveDescribe("impossible error branch with callee capability evidence", () => {
  it("judges a clean callee but abstains on external-only handling", async () => {
    const projectFiles = await project("impossible-error-cases", [
      "src/store.ts",
      "src/service.ts",
      "src/risky.ts",
      "src/capped.ts",
      "src/remote.ts",
    ]);

    const [clean, external] = await Promise.all([
      lint(projectFiles, "src/service.ts", new TypeSafeEvaluator({ apiKey: process.env.TYPESAFE_API_KEY ?? "" })),
      lint(projectFiles, "src/remote.ts", new TypeSafeEvaluator({ apiKey: process.env.TYPESAFE_API_KEY ?? "" })),
    ]);

    expect(clean.length).toBeGreaterThan(0);
    expect(clean[0]?.ruleId).toBe("jev/no-impossible-error-branch");
    expect(external).toEqual([]);
  });
});
