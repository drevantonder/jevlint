import { mkdtemp, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { z } from "zod";
import { analyzeFile } from "../../src/analyze.js";
import { CachedEvaluator } from "../../src/cache.js";
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
const wrapperEvidenceSchema = z.object({
  function: z.object({ name: z.string() }).passthrough(),
}).passthrough();

class RecordingEvaluator implements Evaluator {
  readonly probabilities = new Map<string, number>();
  readonly delegate = new TypeSafeEvaluator({ apiKey: process.env.JEVLINT_TYPESAFE_API_KEY ?? "" });

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
      const evidence = wrapperEvidenceSchema.safeParse(
        candidate?.evidence?.["jev/no-pass-through-wrapper"],
      );
      if (evidence.success) this.probabilities.set(evidence.data.function.name, probability);
    }
    return answers;
  }
}

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

async function lintChangedFile(
  projectFiles: ProjectFile[],
  filePath: string,
  evaluator: Evaluator,
) {
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
  it("separates direct forwarding from boundaries and small named abstractions", async () => {
    const live = new RecordingEvaluator();
    const evaluator = new CachedEvaluator(live, {
      directory: await mkdtemp(join(tmpdir(), "jevlint-live-pass-through-")),
      repository: "/live/pass-through-calibration",
      identity: live.delegate.identity,
    });
    const [smellyProject, boundaryProject, policyProject, forgeCases] = await Promise.all([
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
      project("pass-through-forge-cases", [
        "src/read-google-foundation.ts",
        "src/replace-at.ts",
        "src/access-oauth-random.ts",
      ]),
    ]);

    const [smelly, boundary, ambiguous, foundation, replacement, oauthRandom] = await Promise.all([
      lintChangedFile(smellyProject, "src/get-user.ts", evaluator),
      lintChangedFile(boundaryProject, "src/domain/customer-store.ts", evaluator),
      lintChangedFile(policyProject, "src/active-users.ts", evaluator),
      lintChangedFile(forgeCases, "src/read-google-foundation.ts", evaluator),
      lintChangedFile(forgeCases, "src/replace-at.ts", evaluator),
      lintChangedFile(forgeCases, "src/access-oauth-random.ts", evaluator),
    ]);

    expect(live.probabilities.get("getUserById")).toBeGreaterThanOrEqual(0.7);
    expect(live.probabilities.get("readGoogleFoundation")).toBeGreaterThanOrEqual(0.7);
    expect(live.probabilities.get("persistCustomer")).toBeLessThan(0.6);
    expect(live.probabilities.get("findActiveUsers")).toBeLessThan(0.6);
    expect(live.probabilities.get("replaceAt")).toBeLessThan(0.6);
    expect(live.probabilities.get("accessOAuthRandom")).toBeLessThan(0.6);
    expect(smelly.map(({ span }) => span.start.line)).toEqual([7]);
    expect(foundation.map(({ ruleId }) => ruleId)).toContain("jev/no-pass-through-wrapper");
    expect(boundary.every(({ probability }) => probability < 0.6)).toBe(true);
    expect(ambiguous.every(({ probability }) => probability < 0.6)).toBe(true);
    expect(replacement.every(({ probability }) => probability < 0.6)).toBe(true);
    expect(oauthRandom.every(({ probability }) => probability < 0.6)).toBe(true);

    const liveRequests = evaluator.statistics.liveRequests;
    await Promise.all([
      lintChangedFile(smellyProject, "src/get-user.ts", evaluator),
      lintChangedFile(boundaryProject, "src/domain/customer-store.ts", evaluator),
      lintChangedFile(policyProject, "src/active-users.ts", evaluator),
      lintChangedFile(forgeCases, "src/read-google-foundation.ts", evaluator),
      lintChangedFile(forgeCases, "src/replace-at.ts", evaluator),
      lintChangedFile(forgeCases, "src/access-oauth-random.ts", evaluator),
    ]);
    expect(evaluator.statistics).toMatchObject({
      hits: 6,
      misses: 6,
      writes: 6,
      liveRequests,
    });
    expect(liveRequests).toBe(6);
  });
});
