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
const layerEvidenceSchema = z.object({
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
      const evidence = layerEvidenceSchema.safeParse(
        candidate?.evidence?.["jev/no-shallow-convenience-layer"],
      );
      if (evidence.success) this.probabilities.set(evidence.data.function.name, probability);
    }
    return answers;
  }
}

const repo: ProjectFile = {
  filePath: "src/user-repo.ts",
  source: `export const userRepo = {
  getUser(id: string) {
    return { id };
  },
  saveUser(user: object) {
    return user;
  },
};
`,
};

const smelly: ProjectFile[] = [
  repo,
  {
    filePath: "src/user-service.ts",
    source: `import { userRepo } from "./user-repo";
export class UserService {
  getUser(id: string) {
    return userRepo.getUser(id);
  }
  saveUser(user: object) {
    return userRepo.saveUser(user);
  }
}
`,
  },
  {
    filePath: "src/handler.ts",
    source: `import { userRepo } from "./user-repo";
export function handle(id: string) {
  return userRepo.getUser(id);
}
`,
  },
];

const clean: ProjectFile[] = [
  repo,
  {
    filePath: "src/user-service.ts",
    source: `import { userRepo } from "./user-repo";
export class UserService {
  async getUser(id: string) {
    const user = await userRepo.getUser(id);
    if (!user) throw new Error(id);
    return user;
  }
  saveUser(user: object) {
    return userRepo.saveUser(user);
  }
}
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
  const rule = defaultConfig.rules["jev/no-shallow-convenience-layer"];
  expect(rule).toBeDefined();
  if (!rule) return [];
  const config: JevLintConfig = { rules: { "jev/no-shallow-convenience-layer": rule } };
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

liveDescribe("shallow convenience layer with repository evidence", () => {
  it("separates a mirrored layer from one that adds policy", async () => {
    const evaluator = new RecordingEvaluator();
    const [smellyJudgments, cleanJudgments] = await Promise.all([
      lintChangedFile(smelly, "src/user-service.ts", evaluator),
      lintChangedFile(clean, "src/user-service.ts", evaluator),
    ]);

    expect(evaluator.probabilities.get("getUser")).toBeGreaterThanOrEqual(0.7);
    expect(smellyJudgments.map(({ ruleId }) => ruleId)).toContain("jev/no-shallow-convenience-layer");
    expect(cleanJudgments.every(({ probability }) => probability < 0.6)).toBe(true);
  });
});
