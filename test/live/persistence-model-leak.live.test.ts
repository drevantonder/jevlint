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

const evaluator = new RecordingEvaluator();

async function project(name: string, paths: string[]): Promise<ProjectFile[]> {
  return Promise.all(paths.map(async (filePath) => ({
    filePath,
    source: await readFile(new URL(`${name}/${filePath}`, repositories), "utf8"),
  })));
}

async function lint(projectFiles: ProjectFile[], changedPath: string) {
  const changed = projectFiles.find(({ filePath }) => filePath === changedPath);
  const rule = defaultConfig.rules["jev/no-persistence-model-leak"];
  expect(changed).toBeDefined();
  expect(rule).toBeDefined();
  if (!changed || !rule) return [];
  const config: JevLintConfig = { rules: { "jev/no-persistence-model-leak": rule } };
  return analyzeFile({
    filePath: changed.filePath,
    source: changed.source,
    changedLines: [{ start: 1, end: changed.source.split("\n").length }],
    config,
    projectFiles,
  }, evaluator);
}

liveDescribe("persistence model leak calibration", () => {
  it("separates leaked records from mapping, persistence tooling, and unclear ownership", async () => {
    const [positive, negative, exception, ambiguous] = await Promise.all([
      project("persistence-model-positive", [
        "src/application/load-customer.ts",
        "src/domain/assess-credit.ts",
        "src/persistence/prisma.ts",
      ]),
      project("persistence-model-negative", [
        "src/persistence/customer-repository.ts",
        "src/persistence/prisma.ts",
        "src/domain/customer.ts",
        "src/application/assess-credit.ts",
      ]),
      project("persistence-model-exception", [
        "src/migrations/export-legacy-customers.ts",
        "src/migrations/write-customer-archive.ts",
        "src/persistence/legacy-schema.ts",
        "src/persistence/legacy-database.ts",
      ]),
      project("persistence-model-ambiguous", [
        "src/customers/find-customer.ts",
        "src/customers/show-customer.ts",
        "src/repositories/customer-record.ts",
        "src/repositories/customer-records.ts",
      ]),
    ]);

    const [positiveDiagnostics, negativeDiagnostics, exceptionDiagnostics, ambiguousDiagnostics]
      = await Promise.all([
        lint(positive, "src/application/load-customer.ts"),
        lint(negative, "src/persistence/customer-repository.ts"),
        lint(exception, "src/migrations/export-legacy-customers.ts"),
        lint(ambiguous, "src/customers/find-customer.ts"),
      ]);

    expect(evaluator.probabilities.get("src/application/load-customer.ts"))
      .toBeGreaterThanOrEqual(0.85);
    expect(evaluator.probabilities.get("src/persistence/customer-repository.ts"))
      .toBeLessThan(0.5);
    expect(evaluator.probabilities.get("src/migrations/export-legacy-customers.ts"))
      .toBeLessThan(0.5);
    expect(evaluator.probabilities.get("src/customers/find-customer.ts")).toBeLessThan(0.8);
    expect(positiveDiagnostics).toHaveLength(1);
    expect(negativeDiagnostics).toEqual([]);
    expect(exceptionDiagnostics).toEqual([]);
    expect(ambiguousDiagnostics).toEqual([]);
  });
});
