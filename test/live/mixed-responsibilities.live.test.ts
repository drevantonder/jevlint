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
    name: "mixed-responsibilities-smelly",
    paths: [
      "src/update-profile.ts",
      "src/customer-store.ts",
      "src/revenue-report.ts",
      "src/mailer.ts",
      "src/session-store.ts",
      "src/profile-page.ts",
    ],
    filePath: "src/update-profile.ts",
    expected: "positive",
  },
  {
    name: "mixed-responsibilities-cohesive",
    paths: [
      "src/fulfill-order.ts",
      "src/inventory.ts",
      "src/payments.ts",
      "src/shipments.ts",
      "src/orders.ts",
    ],
    filePath: "src/fulfill-order.ts",
    expected: "negative",
  },
  {
    name: "mixed-responsibilities-boundary",
    paths: [
      "src/register-customer-controller.ts",
      "src/http.ts",
      "src/register-customer.ts",
      "src/responses.ts",
    ],
    filePath: "src/register-customer-controller.ts",
    expected: "exception",
  },
  {
    name: "mixed-responsibilities-ambiguous",
    paths: [
      "src/refresh-workspace.ts",
      "src/catalog.ts",
      "src/cache.ts",
      "src/telemetry.ts",
    ],
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

liveDescribe("mixed responsibilities with ownership evidence", () => {
  it("separates unrelated work from workflows, boundaries, and unclear cases", async () => {
    const evaluator = new RecordingEvaluator();
    const rule = defaultConfig.rules["jev/no-mixed-responsibilities"];
    expect(rule).toBeDefined();
    if (!rule) return;
    const config: JevLintConfig = { rules: { "jev/no-mixed-responsibilities": rule } };

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

    expect(evaluator.probabilities.get("src/update-profile.ts")).toBeGreaterThanOrEqual(0.85);
    expect(evaluator.probabilities.get("src/fulfill-order.ts")).toBeLessThan(0.5);
    expect(evaluator.probabilities.get("src/register-customer-controller.ts")).toBeLessThan(0.5);
    expect(evaluator.probabilities.get("src/refresh-workspace.ts")).toBeLessThan(0.85);
    expect(results.find(({ expected }) => expected === "positive")?.judgments)
      .toEqual([expect.objectContaining({ ruleId: "jev/no-mixed-responsibilities" })]);
    expect(results.filter(({ expected }) => expected !== "positive")
      .flatMap(({ judgments }) => judgments).every(({ probability }) => probability < 0.85))
      .toBe(true);
  });
});
