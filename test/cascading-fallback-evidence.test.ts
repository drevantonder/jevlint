import { readFile } from "node:fs/promises";
import { describe, expect, it } from "vitest";
import { z } from "zod";
import { analyzeFile } from "../src/analyze.js";
import { extractCandidates } from "../src/candidates.js";
import { defaultConfig } from "../src/config.js";
import { buildCascadingFallbackEvidence } from "../src/evidence/cascading-fallback.js";
import type { Candidate, EvaluationRequest, Evaluator, JevLintConfig, ProjectFile } from "../src/types.js";

async function project(name: string, paths: string[]): Promise<ProjectFile[]> {
  return Promise.all(paths.map(async (filePath) => ({
    filePath,
    source: await readFile(
      new URL(`./fixtures/repositories/${name}/${filePath}`, import.meta.url),
      "utf8",
    ),
  })));
}

function candidateFor(files: ProjectFile[], filePath: string, marker: string): Candidate | undefined {
  const file = files.find((entry) => entry.filePath === filePath);
  expect(file).toBeDefined();
  if (!file) return undefined;
  const candidate = extractCandidates(file.filePath, file.source)
    .find(({ kind, source }) => kind === "function" && source.includes(marker));
  expect(candidate).toBeDefined();
  return candidate;
}

describe("cascading fallback evidence", () => {
  it("shows Jev the primary and fallback calls sharing one pool", async () => {
    const files = await project("cascading-fallback-positive", [
      "src/fetch-user.ts",
      "src/db.ts",
      "src/caller.ts",
    ]);
    const candidate = candidateFor(files, "src/fetch-user.ts", "fetchUser");
    if (!candidate) return;

    const evidence = buildCascadingFallbackEvidence(candidate, files);

    expect(evidence).toMatchObject({
      function: {
        name: "fetchUser",
        exported: true,
        source: expect.stringContaining("pool.query"),
      },
      handlers: [
        {
          primaryCalls: [{ root: "pool", importedFrom: "./db.js" }],
          fallbackCalls: [{ root: "pool", importedFrom: "./db.js" }],
          sharedDependencies: [
            { root: "pool", importedFrom: "./db.js" },
          ],
          fallbackReturnsStatic: false,
        },
      ],
      repository: {
        callers: [{ filePath: "src/caller.ts" }],
      },
    });
  });

  it("reports the degraded cache fallback with no shared capability", async () => {
    const files = await project("cascading-fallback-negative", [
      "src/fetch-user.ts",
      "src/db.ts",
    ]);
    const candidate = candidateFor(files, "src/fetch-user.ts", "fetchUser");
    if (!candidate) return;

    const evidence = buildCascadingFallbackEvidence(candidate, files);

    expect(evidence).toMatchObject({
      handlers: [
        {
          fallbackCalls: [{ root: "staticCache", importedFrom: null }],
          sharedDependencies: [],
          fallbackReturnsStatic: true,
        },
      ],
    });
  });

  it("abstains when the fallback returns without invoking any capability", () => {
    const source = `export async function fetchUser(id: number): Promise<unknown> {
      try {
        return await loadUser(id);
      } catch {
        return { id, name: "unknown" };
      }
    }`;
    const candidate = extractCandidates("src/fetch-user.ts", source)
      .find(({ kind }) => kind === "function");
    expect(candidate).toBeDefined();
    if (!candidate) return;

    expect(buildCascadingFallbackEvidence(candidate, [{ filePath: "src/fetch-user.ts", source }]))
      .toBeUndefined();
  });

  it("abstains when the function has no catch block", () => {
    const source = `export async function fetchUser(id: number): Promise<unknown> {
      return { id };
    }`;
    const candidate = extractCandidates("src/fetch-user.ts", source)
      .find(({ kind }) => kind === "function");
    expect(candidate).toBeDefined();
    if (!candidate) return;

    expect(buildCascadingFallbackEvidence(candidate, [{ filePath: "src/fetch-user.ts", source }]))
      .toBeUndefined();
  });
});

describe("cascading fallback retry shape", () => {
  it("records shrinking scope with singleton and give-up floors for halving retries", async () => {
    const files = await project("cascading-fallback-halving", [
      "src/embed-batch.ts",
      "src/client.ts",
      "src/caller.ts",
    ]);
    const candidate = candidateFor(files, "src/embed-batch.ts", "embedBatch");
    if (!candidate) return;

    const evidence = buildCascadingFallbackEvidence(candidate, files);

    expect(evidence).toMatchObject({
      function: { name: "embedBatch", exported: true },
      handlers: [
        {
          primaryCalls: [{ root: "client", importedFrom: "./client.js" }],
          sharedDependencies: expect.arrayContaining([
            expect.objectContaining({
              root: "client",
              importedFrom: "./client.js",
              scope: "shrinking",
              scopeDetail: expect.stringContaining("slice"),
              floors: expect.arrayContaining([
                expect.objectContaining({ kind: "singleton" }),
                expect.objectContaining({ kind: "give-up" }),
              ]),
            }),
          ]),
          fallbackReturnsStatic: false,
        },
      ],
    });
    const chains = evidence?.handlers[0]?.sharedDependencies ?? [];
    expect(chains.length).toBeGreaterThan(0);
    for (const chain of chains) {
      expect(chain.scope).toBe("shrinking");
      expect(chain.floors.map((floor) => floor.kind)).toEqual(
        expect.arrayContaining(["singleton", "give-up"]),
      );
    }
  });

  it("records same-size scope with no floor for identical retries", async () => {
    const files = await project("cascading-fallback-samesize", [
      "src/fetch-user.ts",
      "src/db.ts",
      "src/caller.ts",
    ]);
    const candidate = candidateFor(files, "src/fetch-user.ts", "fetchUser");
    if (!candidate) return;

    const evidence = buildCascadingFallbackEvidence(candidate, files);

    expect(evidence).toMatchObject({
      function: { name: "fetchUser", exported: true },
      handlers: [
        {
          sharedDependencies: [
            {
              root: "pool",
              importedFrom: "./db.js",
              scope: "same-size",
              scopeDetail: expect.stringContaining("unchanged"),
              floors: [],
            },
          ],
          fallbackReturnsStatic: false,
        },
      ],
    });
  });
});

describe("cascading fallback reported probabilities", () => {
  const ruleId = "jev/no-cascading-fallback";

  const questionInstructionsSchema = z.object({ inspect: z.string() }).passthrough();

  class ScopeScoringEvaluator implements Evaluator {
    requests: EvaluationRequest[] = [];

    async evaluate(request: EvaluationRequest): Promise<Record<string, number>> {
      this.requests.push(request);
      const scores: Record<string, number> = {};
      for (const [questionId, question] of Object.entries(request.questions)) {
        const instructions = questionInstructionsSchema.safeParse(question.instructions);
        const match = instructions.success
          ? /candidates\[(\d+)]/.exec(instructions.data.inspect)
          : null;
        const candidate = match?.[1] === undefined
          ? undefined
          : request.state.candidates[Number(match[1])];
        const evidence = JSON.stringify(candidate?.evidence?.[ruleId] ?? null);
        scores[questionId] = evidence.includes("\"scope\":\"shrinking\"") ? 0.18 : 0.86;
      }
      return scores;
    }
  }

  async function judgmentsFor(name: string, paths: string[], entry: string, evaluator: Evaluator) {
    const files = await project(name, paths);
    const changed = files.find((file) => file.filePath === entry);
    expect(changed).toBeDefined();
    if (!changed) return [];
    const rule = defaultConfig.rules[ruleId];
    expect(rule).toBeDefined();
    if (!rule) return [];
    const config: JevLintConfig = { rules: { [ruleId]: rule } };
    return analyzeFile(
      {
        filePath: changed.filePath,
        source: changed.source,
        changedLines: [{ start: 1, end: changed.source.split("\n").length }],
        config,
        projectFiles: files,
      },
      evaluator,
    );
  }

  it("reports the evaluator raw probability with the retry-shape evidence attached", async () => {
    const evaluator = new ScopeScoringEvaluator();
    const [halving, samesize] = await Promise.all([
      judgmentsFor(
        "cascading-fallback-halving",
        ["src/embed-batch.ts", "src/client.ts", "src/caller.ts"],
        "src/embed-batch.ts",
        evaluator,
      ),
      judgmentsFor(
        "cascading-fallback-samesize",
        ["src/fetch-user.ts", "src/db.ts", "src/caller.ts"],
        "src/fetch-user.ts",
        evaluator,
      ),
    ]);

    expect(halving).toHaveLength(1);
    expect(halving[0]).toMatchObject({
      ruleId,
      probability: 0.18,
      evidence: expect.objectContaining({
        handlers: [
          expect.objectContaining({
            sharedDependencies: expect.arrayContaining([
              expect.objectContaining({ scope: "shrinking" }),
            ]),
          }),
        ],
      }),
    });
    expect(samesize).toHaveLength(1);
    expect(samesize[0]).toMatchObject({
      ruleId,
      probability: 0.86,
      evidence: expect.objectContaining({
        handlers: [
          expect.objectContaining({
            sharedDependencies: [expect.objectContaining({ scope: "same-size", floors: [] })],
          }),
        ],
      }),
    });
  });
});
