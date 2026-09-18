import { describe, expect, it } from "vitest";
import { z } from "zod";
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
const questionInstructionsSchema = z.object({ inspect: z.string() }).passthrough();
const signatureEvidenceSchema = z.object({
  function: z.object({ name: z.string() }).passthrough(),
}).passthrough();

class RecordingEvaluator implements Evaluator {
  readonly probabilities = new Map<string, number>();
  readonly delegate = new TypeSafeEvaluator({ apiKey: process.env.TYPESAFE_API_KEY ?? "" });

  async evaluate(request: EvaluationRequest): Promise<Record<string, number>> {
    const answers = await this.delegate.evaluate(request);
    for (const [questionId, probability] of Object.entries(answers)) {
      const instructions = questionInstructionsSchema.safeParse(
        request.questions[questionId]?.instructions,
      );
      if (!instructions.success) continue;
      const match = /candidates\[(\d+)]/.exec(instructions.data.inspect);
      const candidate = match?.[1] === undefined
        ? undefined
        : request.state.candidates[Number(match[1])];
      const evidence = signatureEvidenceSchema.safeParse(
        candidate?.evidence?.["jev/no-implementation-type-in-signature"],
      );
      if (evidence.success) this.probabilities.set(evidence.data.function.name, probability);
    }
    return answers;
  }
}

const smelly: ProjectFile[] = [
  {
    filePath: "src/app.ts",
    source: `import { getUser } from "./service";
export async function handle(db: never, id: string): Promise<string> {
  const user = await getUser(db, id);
  return user?.displayName ?? "unknown";
}
`,
  },
  {
    filePath: "src/service.ts",
    source: `import type { DbClient } from "db-driver";
export interface User {
  id: string;
  displayName: string;
}
export async function getUser(db: DbClient, id: string): Promise<User | undefined> {
  return db.findUser(id);
}
`,
  },
];

const clean: ProjectFile[] = [
  {
    filePath: "src/app.ts",
    source: `import { getUser } from "./service";
export async function handle(id: string): Promise<string> {
  const user = await getUser(id);
  return user?.displayName ?? "unknown";
}
`,
  },
  {
    filePath: "src/service.ts",
    source: `export interface User {
  id: string;
  displayName: string;
}
export async function getUser(id: string): Promise<User | undefined> {
  return lookup(id);
}
declare function lookup(id: string): Promise<User | undefined>;
`,
  },
];

async function lintChangedFile(
  projectFiles: ProjectFile[],
  filePath: string,
  evaluator: Evaluator,
) {
  const changed = projectFiles.find((file) => file.filePath === filePath);
  expect(changed).toBeDefined();
  if (!changed) return [];
  const rule = defaultConfig.rules["jev/no-implementation-type-in-signature"];
  expect(rule).toBeDefined();
  if (!rule) return [];
  const config: JevLintConfig = { rules: { "jev/no-implementation-type-in-signature": rule } };
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

liveDescribe("implementation type in signature with origin evidence", () => {
  it("separates a driver-typed export from a domain-typed one", async () => {
    const smellyEvaluator = new RecordingEvaluator();
    const cleanEvaluator = new RecordingEvaluator();
    const [smellyJudgments, cleanJudgments] = await Promise.all([
      lintChangedFile(smelly, "src/service.ts", smellyEvaluator),
      lintChangedFile(clean, "src/service.ts", cleanEvaluator),
    ]);

    expect(smellyEvaluator.probabilities.get("getUser")).toBeGreaterThanOrEqual(0.7);
    expect(smellyJudgments.map(({ ruleId }) => ruleId)).toContain(
      "jev/no-implementation-type-in-signature",
    );
    expect(cleanJudgments.every(({ probability }) => probability < 0.6)).toBe(true);
  });
});
