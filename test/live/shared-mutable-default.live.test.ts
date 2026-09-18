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
    filePath: "src/jobs.ts",
    source: `export function runJob(name: string, opts: { retried?: boolean } = {}) {
  opts.retried = true;
  return { name, ...opts };
}
`,
  },
  {
    filePath: "src/handler.ts",
    source: `import { runJob } from "./jobs";
export function handle(name: string) {
  return runJob(name);
}
`,
  },
];

const clean: ProjectFile[] = [
  {
    filePath: "src/jobs.ts",
    source: `export function runJob(name: string, opts: { retried?: boolean } = {}) {
  return { name, retried: opts.retried ?? false };
}
`,
  },
];

async function lintChangedFile(projectFiles: ProjectFile[], evaluator: Evaluator) {
  const changed = projectFiles.find((file) => file.filePath === "src/jobs.ts");
  expect(changed).toBeDefined();
  if (!changed) return [];
  const rule = defaultConfig.rules["jev/no-shared-mutable-default"];
  expect(rule).toBeDefined();
  if (!rule) return [];
  const config: JevLintConfig = { rules: { "jev/no-shared-mutable-default": rule } };
  return analyzeFile(
    {
      filePath: "src/jobs.ts",
      source: changed.source,
      changedLines: [{ start: 1, end: changed.source.split("\n").length }],
      config,
      projectFiles,
    },
    evaluator,
  );
}

liveDescribe("shared mutable default with repository evidence", () => {
  it("separates a mutated default from a read-only one", async () => {
    const [smellyJudgments, cleanJudgments] = await Promise.all([
      lintChangedFile(smelly, new PassthroughEvaluator()),
      lintChangedFile(clean, new PassthroughEvaluator()),
    ]);

    expect(smellyJudgments.map(({ ruleId }) => ruleId)).toContain(
      "jev/no-shared-mutable-default",
    );
    expect(cleanJudgments.every(({ probability }) => probability < 0.6)).toBe(true);
  });
});
