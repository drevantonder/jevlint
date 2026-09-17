import { describe, expect, it } from "vitest";
import { analyzeFile } from "../../src/analyze.js";
import { defaultConfig } from "../../src/config.js";
import { TypeSafeEvaluator } from "../../src/typesafe-evaluator.js";
import type { EvaluationRequest, Evaluator, JevLintConfig, ProjectFile } from "../../src/types.js";

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

const OWNER = `import { getUser } from "./users.js";
export async function syncAll(client: string, ids: string[]): Promise<string[]> {
  const out: string[] = [];
  for (const id of ids) {
    out.push(await getUser(client, id));
  }
  return out;
}
`;

const USERS = `export async function getUser(id: string): Promise<string> {
  return id;
}
export async function getUsers(ids: string[]): Promise<string[]> {
  return ids;
}
`;

async function lint(projectFiles: ProjectFile[], evaluator: Evaluator) {
  const changed = projectFiles[0];
  const rule = defaultConfig.rules["jev/no-chatty-interface"];
  expect(changed).toBeDefined();
  expect(rule).toBeDefined();
  if (!changed || !rule) return [];
  const config: JevLintConfig = { rules: { "jev/no-chatty-interface": rule } };
  return analyzeFile({
    filePath: changed.filePath,
    source: changed.source,
    changedLines: [{ start: 1, end: changed.source.split("\n").length }],
    config,
    projectFiles,
  }, evaluator);
}

liveDescribe("chatty interface live judgment", () => {
  it("scores sequential per-item calls with a batch sibling available", async () => {
    const files: ProjectFile[] = [
      { filePath: "src/sync.ts", source: OWNER },
      { filePath: "src/users.ts", source: USERS },
    ];
    const evaluator = new RecordingEvaluator();

    const judgments = await lint(files, evaluator);

    expect(judgments.map(({ ruleId }) => ruleId)).toContain("jev/no-chatty-interface");
    for (const judgment of judgments) {
      expect(judgment.probability).toBeGreaterThanOrEqual(0);
      expect(judgment.probability).toBeLessThanOrEqual(1);
    }
  });
});
