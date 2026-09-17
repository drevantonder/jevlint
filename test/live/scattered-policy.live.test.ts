import { readFile } from "node:fs/promises";
import { describe, expect, it } from "vitest";
import { analyzeFile } from "../../src/analyze.js";
import { defaultConfig } from "../../src/config.js";
import { TypeSafeEvaluator } from "../../src/typesafe-evaluator.js";
import type { EvaluationRequest, Evaluator, JevLintConfig, ProjectFile } from "../../src/types.js";

const liveDescribe = process.env.RUN_LIVE_JEV === "1" ? describe : describe.skip;
const repositories = new URL("../fixtures/repositories/", import.meta.url);

class RecordingEvaluator implements Evaluator {
  readonly probabilities = new Map<string, number>();
  readonly delegate = new TypeSafeEvaluator();

  async evaluate(request: EvaluationRequest): Promise<Record<string, number>> {
    const answers = await this.delegate.evaluate(request);
    const probability = answers.q0;
    if (probability !== undefined) this.probabilities.set(request.state.file.path, probability);
    return answers;
  }
}

const cases = [
  {
    name: "scattered-policy-smelly",
    paths: ["src/route-support.ts", "src/account-badge.ts", "src/support-page.ts"],
    filePath: "src/route-support.ts",
    expected: "positive",
  },
  {
    name: "scattered-policy-independent",
    paths: ["src/tax-report.ts", "src/campaign.ts"],
    filePath: "src/tax-report.ts",
    expected: "negative",
  },
  {
    name: "scattered-policy-boundary",
    paths: ["src/payments-adapter.ts", "src/crm-adapter.ts"],
    filePath: "src/payments-adapter.ts",
    expected: "exception",
  },
  {
    name: "scattered-policy-ambiguous",
    paths: ["src/refresh-workspace.ts", "src/index-workspace.ts"],
    filePath: "src/refresh-workspace.ts",
    expected: "ambiguous",
  },
] as const;

async function loadProject(name: string, paths: readonly string[]): Promise<ProjectFile[]> {
  return Promise.all(paths.map(async (filePath) => ({
    filePath,
    source: await readFile(new URL(`${name}/${filePath}`, repositories), "utf8"),
  })));
}

liveDescribe("scattered policy with repository evidence", () => {
  it("separates duplicated policy from coincidental, boundary, and unclear matches", async () => {
    const evaluator = new RecordingEvaluator();
    const rule = defaultConfig.rules["jev/no-scattered-policy"];
    expect(rule).toBeDefined();
    if (!rule) return;
    const config: JevLintConfig = { rules: { "jev/no-scattered-policy": rule } };

    const results = await Promise.all(cases.map(async (entry) => {
      const files = await loadProject(entry.name, entry.paths);
      const owner = files.find(({ filePath }) => filePath === entry.filePath);
      expect(owner).toBeDefined();
      if (!owner) return { expected: entry.expected, judgments: [] };
      const judgments = await analyzeFile({
        filePath: owner.filePath,
        source: owner.source,
        changedLines: [{ start: 1, end: owner.source.split("\n").length }],
        config,
        projectFiles: files,
      }, evaluator);
      return { expected: entry.expected, judgments };
    }));

    expect(evaluator.probabilities.get("src/route-support.ts")).toBeGreaterThanOrEqual(0.85);
    expect(evaluator.probabilities.get("src/tax-report.ts")).toBeLessThan(0.5);
    expect(evaluator.probabilities.get("src/payments-adapter.ts")).toBeLessThan(0.5);
    expect(evaluator.probabilities.get("src/refresh-workspace.ts")).toBeLessThan(0.85);
    expect(results.find(({ expected }) => expected === "positive")?.judgments)
      .toEqual([expect.objectContaining({ ruleId: "jev/no-scattered-policy" })]);
    expect(results.filter(({ expected }) => expected !== "positive")
      .flatMap(({ judgments }) => judgments).every(({ probability }) => probability < 0.85))
      .toBe(true);
  });
});
