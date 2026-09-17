import { describe, expect, it } from "vitest";
import { analyzeChanges } from "../../src/analyze.js";
import { defaultConfig } from "../../src/config.js";
import { TypeSafeEvaluator } from "../../src/typesafe-evaluator.js";
import type {
  EvaluationRequest,
  Evaluator,
  JevLintConfig,
  ProjectFile,
  SourceFile,
} from "../../src/types.js";

const liveDescribe = process.env.RUN_LIVE_JEV === "1" ? describe : describe.skip;

class PassthroughEvaluator implements Evaluator {
  readonly delegate = new TypeSafeEvaluator();
  evaluate(request: EvaluationRequest): Promise<Record<string, number>> {
    return this.delegate.evaluate(request);
  }
}

const newClient = `export function get(url: string) {
  return fetch(url);
}
export function post(url: string, body: unknown) {
  return fetch(url, { method: "POST", body: JSON.stringify(body) });
}
`;

const twinClient = `export function get(url: string) {
  return fetch(url);
}
export function post(url: string, body: unknown) {
  return fetch(url, { method: "POST", body: JSON.stringify(body) });
}
`;

const totals = `export function sum(lines: number[]) {
  return lines.reduce((total, line) => total + line, 0);
}
`;

type Scenario = {
  changes: SourceFile[];
  files: ProjectFile[];
};

function scenario(siblingPath: string, siblingSource: string): Scenario {
  const changes: SourceFile[] = [{
    filePath: "src/http-client.ts",
    source: newClient,
    oldSource: null,
    changedLines: [{ start: 1, end: 6 }],
  }];
  return {
    changes,
    files: [
      { filePath: "src/http-client.ts", source: newClient },
      { filePath: siblingPath, source: siblingSource },
    ],
  };
}

async function lint(changes: SourceFile[], files: ProjectFile[], evaluator: Evaluator) {
  const rule = defaultConfig.rules["jev/no-duplicate-module-role"];
  expect(rule).toBeDefined();
  if (!rule) return [];
  const config: JevLintConfig = { rules: { "jev/no-duplicate-module-role": rule } };
  return analyzeChanges({ changes, config, projectFiles: files }, evaluator);
}

liveDescribe("duplicate module role calibration", () => {
  it("flags a twin client module but keeps an unrelated new module", async () => {
    const twin = scenario("src/api-client.ts", twinClient);
    const fresh = scenario("src/totals.ts", totals);
    const [twinJudgments, freshJudgments] = await Promise.all([
      lint(twin.changes, twin.files, new PassthroughEvaluator()),
      lint(fresh.changes, fresh.files, new PassthroughEvaluator()),
    ]);

    expect(twinJudgments.map(({ ruleId }) => ruleId)).toContain("jev/no-duplicate-module-role");
    expect(freshJudgments.every(({ probability }) => probability < 0.6)).toBe(true);
  });
});
