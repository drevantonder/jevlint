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

class PassthroughEvaluator implements Evaluator {
  readonly delegate = new TypeSafeEvaluator({ apiKey: process.env.TYPESAFE_API_KEY ?? "" });
  evaluate(request: EvaluationRequest): Promise<Record<string, number>> {
    return this.delegate.evaluate(request);
  }
}

const smelly: ProjectFile[] = [
  {
    filePath: "src/api.ts",
    source: `export function fetchUser(id: string, verbose?: boolean, timeout?: number) {
  return { id, verbose, timeout };
}

export function fetchOrg(id: string, options: { verbose?: boolean; timeout?: number }) {
  return { id, ...options };
}
`,
  },
  {
    filePath: "src/handler.ts",
    source: `import { fetchUser } from "./api";
export function handle(id: string) {
  return fetchUser(id, undefined, 5000);
}
`,
  },
];

const clean: ProjectFile[] = [
  {
    filePath: "src/api.ts",
    source: `export function fetchUser(id: string, verbose?: boolean) {
  return { id, verbose };
}

export function fetchOrg(id: string, limit?: number) {
  return { id, limit };
}
`,
  },
];

async function lintChangedFile(projectFiles: ProjectFile[], evaluator: Evaluator) {
  const changed = projectFiles.find((file) => file.filePath === "src/api.ts");
  expect(changed).toBeDefined();
  if (!changed) return [];
  const rule = defaultConfig.rules["jev/no-positional-extension-drift"];
  expect(rule).toBeDefined();
  if (!rule) return [];
  const config: JevLintConfig = { rules: { "jev/no-positional-extension-drift": rule } };
  return analyzeFile(
    {
      filePath: "src/api.ts",
      source: changed.source,
      changedLines: [{ start: 1, end: changed.source.split("\n").length }],
      config,
      projectFiles,
    },
    evaluator,
  );
}

liveDescribe("positional extension drift with repository evidence", () => {
  it("separates positional growth against a bag convention from uniform growth", async () => {
    const [smellyJudgments, cleanJudgments] = await Promise.all([
      lintChangedFile(smelly, new PassthroughEvaluator()),
      lintChangedFile(clean, new PassthroughEvaluator()),
    ]);

    expect(smellyJudgments.map(({ ruleId }) => ruleId)).toContain(
      "jev/no-positional-extension-drift",
    );
    expect(cleanJudgments.every(({ probability }) => probability < 0.6)).toBe(true);
  });
});
