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
  readonly delegate = new TypeSafeEvaluator();
  evaluate(request: EvaluationRequest): Promise<Record<string, number>> {
    return this.delegate.evaluate(request);
  }
}

const smelly: ProjectFile[] = [
  {
    filePath: "src/store.ts",
    source: `export function findUser(id: string): User | null {
  const user = store.get(id);
  if (!user) return null;
  return user;
}

export function findOrg(id: string): Org | undefined {
  const org = store.getOrg(id);
  if (!org) return undefined;
  return org;
}
`,
  },
  {
    filePath: "src/handler.ts",
    source: `import { findUser, findOrg } from "./store";
export function handle(userId: string, orgId: string) {
  const user = findUser(userId);
  if (user === undefined) return null;
  return findOrg(orgId);
}
`,
  },
];

const clean: ProjectFile[] = [
  {
    filePath: "src/store.ts",
    source: `export function findUser(id: string): User | null {
  const user = store.get(id);
  if (!user) return null;
  return user;
}

export function findOrg(id: string): Org | null {
  const org = store.getOrg(id);
  if (!org) return null;
  return org;
}
`,
  },
];

async function lintChangedFile(projectFiles: ProjectFile[], evaluator: Evaluator) {
  const changed = projectFiles.find((file) => file.filePath === "src/store.ts");
  expect(changed).toBeDefined();
  if (!changed) return [];
  const rule = defaultConfig.rules["jev/no-mixed-absence-convention"];
  expect(rule).toBeDefined();
  if (!rule) return [];
  const config: JevLintConfig = { rules: { "jev/no-mixed-absence-convention": rule } };
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

liveDescribe("mixed absence convention with repository evidence", () => {
  it("separates mixed null and undefined spellings from one convention", async () => {
    const [smellyJudgments, cleanJudgments] = await Promise.all([
      lintChangedFile(smelly, new PassthroughEvaluator()),
      lintChangedFile(clean, new PassthroughEvaluator()),
    ]);

    expect(smellyJudgments.map(({ ruleId }) => ruleId)).toContain(
      "jev/no-mixed-absence-convention",
    );
    expect(cleanJudgments.every(({ probability }) => probability < 0.6)).toBe(true);
  });
});
