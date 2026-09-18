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
  readonly delegate = new TypeSafeEvaluator({ apiKey: process.env.TYPESAFE_API_KEY ?? "" });

  async evaluate(request: EvaluationRequest): Promise<Record<string, number>> {
    const answers = await this.delegate.evaluate(request);
    const probability = answers.q0;
    if (probability !== undefined) this.probabilities.set(request.state.file.path, probability);
    return answers;
  }
}

const cases = [
  {
    name: "data-clump-smelly",
    paths: ["src/shipping-quote.ts", "src/shipping-label.ts", "src/validate-address.ts", "src/checkout.ts"],
    filePath: "src/shipping-quote.ts",
    expected: "positive",
  },
  {
    name: "data-clump-scalars",
    paths: ["src/clamp.ts", "src/normalize.ts", "src/in-range.ts"],
    filePath: "src/clamp.ts",
    expected: "negative",
  },
  {
    name: "data-clump-framework",
    paths: ["src/auth-middleware.ts", "src/trace-middleware.ts", "src/csrf-middleware.ts"],
    filePath: "src/auth-middleware.ts",
    expected: "exception",
  },
  {
    name: "data-clump-ambiguous",
    paths: ["src/copy-resource.ts", "src/sync-resource.ts", "src/move-resource.ts"],
    filePath: "src/copy-resource.ts",
    expected: "ambiguous",
  },
] as const;

async function loadProject(name: string, paths: readonly string[]): Promise<ProjectFile[]> {
  return Promise.all(paths.map(async (filePath) => ({
    filePath,
    source: await readFile(new URL(`${name}/${filePath}`, repositories), "utf8"),
  })));
}

liveDescribe("data clumps with repository evidence", () => {
  it("separates a latent domain value from scalar, framework, and unclear signatures", async () => {
    const evaluator = new RecordingEvaluator();
    const rule = defaultConfig.rules["jev/no-data-clump"];
    expect(rule).toBeDefined();
    if (!rule) return;
    const config: JevLintConfig = { rules: { "jev/no-data-clump": rule } };

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

    expect(evaluator.probabilities.get("src/shipping-quote.ts")).toBeGreaterThanOrEqual(0.85);
    expect(evaluator.probabilities.get("src/clamp.ts")).toBeLessThan(0.5);
    expect(evaluator.probabilities.get("src/auth-middleware.ts")).toBeLessThan(0.5);
    expect(evaluator.probabilities.get("src/copy-resource.ts")).toBeLessThan(0.85);
    expect(results.find(({ expected }) => expected === "positive")?.judgments)
      .toEqual([expect.objectContaining({ ruleId: "jev/no-data-clump" })]);
    expect(results.filter(({ expected }) => expected !== "positive")
      .flatMap(({ judgments }) => judgments).every(({ probability }) => probability < 0.85))
      .toBe(true);
  });
});
