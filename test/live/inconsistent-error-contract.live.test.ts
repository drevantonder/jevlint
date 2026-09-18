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
    filePath: "src/store.ts",
    source: `export function getUser(id: string) {
  const user = store.get(id);
  if (!user) throw new NotFoundError(id);
  return user;
}

export function getOrg(id: string) {
  const org = store.getOrg(id);
  if (!org) return null;
  return org;
}
`,
  },
  {
    filePath: "src/handler.ts",
    source: `import { getUser, getOrg } from "./store";
export function handle(userId: string, orgId: string) {
  try {
    return getUser(userId);
  } catch {
    return getOrg(orgId);
  }
}
`,
  },
];

const clean: ProjectFile[] = [
  {
    filePath: "src/store.ts",
    source: `export function getUser(id: string) {
  const user = store.get(id);
  if (!user) throw new NotFoundError(id);
  return user;
}

export function getOrg(id: string) {
  const org = store.getOrg(id);
  if (!org) throw new NotFoundError(id);
  return org;
}
`,
  },
];

async function lintChangedFile(projectFiles: ProjectFile[], evaluator: Evaluator) {
  const changed = projectFiles.find((file) => file.filePath === "src/store.ts");
  expect(changed).toBeDefined();
  if (!changed) return [];
  const rule = defaultConfig.rules["jev/no-inconsistent-error-contract"];
  expect(rule).toBeDefined();
  if (!rule) return [];
  const config: JevLintConfig = { rules: { "jev/no-inconsistent-error-contract": rule } };
  return analyzeFile(
    {
      filePath: "src/store.ts",
      source: changed.source,
      changedLines: [{ start: 1, end: changed.source.split("\n").length }],
      config,
      projectFiles,
    },
    evaluator,
  );
}

liveDescribe("inconsistent error contract with repository evidence", () => {
  it("separates mixed failure channels from a uniform contract", async () => {
    const [smellyJudgments, cleanJudgments] = await Promise.all([
      lintChangedFile(smelly, new PassthroughEvaluator()),
      lintChangedFile(clean, new PassthroughEvaluator()),
    ]);

    expect(smellyJudgments.map(({ ruleId }) => ruleId)).toContain(
      "jev/no-inconsistent-error-contract",
    );
    expect(cleanJudgments.every(({ probability }) => probability < 0.6)).toBe(true);
  });
});
