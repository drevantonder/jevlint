import { readFile } from "node:fs/promises";
import { describe, expect, it } from "vitest";
import { analyzeFile } from "../../src/analyze.js";
import { defaultConfig } from "../../src/config.js";
import { TypeSafeEvaluator } from "../../src/typesafe-evaluator.js";
import type {
  EvaluationRequest,
  Evaluator,
  JevLintConfig,
  ProjectFile,
} from "../../src/types.js";

const liveDescribe = process.env.RUN_LIVE_JEV === "1" ? describe : describe.skip;

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
const repositories = new URL("../fixtures/repositories/", import.meta.url);

async function project(
  name: string,
  paths: string[],
): Promise<ProjectFile[]> {
  return Promise.all(paths.map(async (filePath) => ({
    filePath,
    source: await readFile(new URL(`${name}/${filePath}`, repositories), "utf8"),
  })));
}

async function lintChangedFile(projectFiles: ProjectFile[], filePath: string) {
  const changed = projectFiles.find((file) => file.filePath === filePath);
  expect(changed).toBeDefined();
  if (!changed) return [];
  const rule = defaultConfig.rules["jev/no-pass-through-wrapper"];
  expect(rule).toBeDefined();
  if (!rule) return [];
  const config: JevLintConfig = {
    rules: { "jev/no-pass-through-wrapper": rule },
  };
  return analyzeFile(
    {
      filePath,
      source: changed.source,
      changedLines: [{ start: 1, end: changed.source.split("\n").length }],
      config,
      projectFiles,
    },
    evaluator,
  );
}

liveDescribe("pass-through wrapper with repository evidence", () => {
  it("flags redundant delegation but keeps a useful external dependency boundary", async () => {
    const [smellyProject, boundaryProject, policyProject] = await Promise.all([
      project("pass-through-smelly", [
        "src/get-user.ts",
        "src/profile.ts",
      ]),
      project("pass-through-boundary", [
        "src/domain/customer-store.ts",
        "src/services/register-customer.ts",
      ]),
      project("pass-through-policy", [
        "src/active-users.ts",
        "src/dashboard.ts",
        "src/users-repository.ts",
      ]),
    ]);

    const [smellyDiagnostics, boundaryDiagnostics, policyDiagnostics] = await Promise.all([
      lintChangedFile(smellyProject, "src/get-user.ts"),
      lintChangedFile(boundaryProject, "src/domain/customer-store.ts"),
      lintChangedFile(policyProject, "src/active-users.ts"),
    ]);

    expect(evaluator.probabilities.get("src/get-user.ts")).toBeGreaterThanOrEqual(0.8);
    expect(evaluator.probabilities.get("src/domain/customer-store.ts")).toBeLessThan(0.5);
    expect(evaluator.probabilities.get("src/active-users.ts")).toBeLessThan(0.8);
    expect(smellyDiagnostics.map(({ line }) => line)).toEqual([7]);
    expect(boundaryDiagnostics).toEqual([]);
    expect(policyDiagnostics).toEqual([]);
  });
});
