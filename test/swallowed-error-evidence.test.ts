import { readFile } from "node:fs/promises";
import { describe, expect, it } from "vitest";
import { analyzeFileWithFailures } from "../src/analyze.js";
import { extractCandidates } from "../src/candidates.js";
import { defaultConfig } from "../src/config.js";
import { buildSwallowedErrorEvidence } from "../src/evidence/swallowed-error.js";
import type {
  Candidate,
  EvaluationRequest,
  Evaluator,
  JevLintConfig,
  ProjectFile,
} from "../src/types.js";

const repositories = new URL("./fixtures/repositories/", import.meta.url);

async function project(name: string, paths: string[]): Promise<ProjectFile[]> {
  return Promise.all(paths.map(async (filePath) => ({
    filePath,
    source: await readFile(new URL(`${name}/${filePath}`, repositories), "utf8"),
  })));
}

describe("swallowed error evidence", () => {
  it("connects each catch outcome to continuation, imports, and callers", async () => {
    const projectFiles = await project("swallowed-error-positive", [
      "src/publish-invoice.ts",
      "src/services.ts",
      "src/billing.ts",
    ]);
    const owner = projectFiles[0];
    expect(owner).toBeDefined();
    if (!owner) return;
    const candidate = extractCandidates(owner.filePath, owner.source)
      .find(({ source }) => source.includes("function publishInvoice"));
    expect(candidate).toBeDefined();
    if (!candidate) return;

    const evidence = buildSwallowedErrorEvidence(candidate, projectFiles);

    expect(evidence).toMatchObject({
      function: {
        name: "publishInvoice",
        exported: true,
        source: expect.stringContaining("status: \"published\""),
      },
      handlers: [{
        caught: "error",
        usesCaughtError: true,
        tryBlock: expect.stringContaining("invoiceEvents.publish"),
        catchBody: expect.stringContaining("logger.error"),
        throws: [],
        returns: [],
        calls: [expect.stringContaining("logger.error")],
        continuationAfterTry: expect.stringContaining("markPublished"),
      }],
      repository: {
        callers: [expect.objectContaining({
          filePath: "src/billing.ts",
          call: "publishInvoice(invoiceId)",
        })],
        relatedModules: [expect.objectContaining({
          filePath: "src/services.ts",
          source: expect.stringContaining("invoiceEvents"),
        })],
      },
    });
  });

  it("keeps explicit propagation visible to the semantic judgment", async () => {
    const projectFiles = await project("swallowed-error-negative", [
      "src/store-receipt.ts",
      "src/receipt-store.ts",
      "src/checkout.ts",
    ]);
    const owner = projectFiles[0];
    expect(owner).toBeDefined();
    if (!owner) return;
    const candidate = extractCandidates(owner.filePath, owner.source)[0];
    expect(candidate).toBeDefined();
    if (!candidate) return;

    expect(buildSwallowedErrorEvidence(candidate, projectFiles)).toMatchObject({
      handlers: [{
        throws: [expect.stringContaining("throw new Error")],
        returns: [],
      }],
    });
  });

  it("does not assign a nested function's catch to its enclosing function", () => {
    const source = `
      export async function outer() {
        const task = async () => {
          try { await send(); } catch (error) { logger.warn(error); }
        };
        return task();
      }
    `;
    const candidates = extractCandidates("src/outer.ts", source);
    const outer = candidates.find(({ source: candidateSource }) =>
      candidateSource.includes("function outer"));
    const task = candidates.find(({ source: candidateSource }) =>
      candidateSource.startsWith("async ()"));
    expect(outer).toBeDefined();
    expect(task).toBeDefined();
    if (!outer || !task) return;

    const projectFiles = [{ filePath: "src/outer.ts", source }];
    expect(buildSwallowedErrorEvidence(outer, projectFiles)).toBeUndefined();
    expect(buildSwallowedErrorEvidence(task, projectFiles)).toMatchObject({
      handlers: [{ caught: "error" }],
    });
  });

  it("abstains when a function has no catch handler", () => {
    const source = "export async function load() { return await fetchValue(); }";
    const candidate = extractCandidates("src/load.ts", source)[0];
    expect(candidate).toBeDefined();
    if (!candidate) return;

    expect(buildSwallowedErrorEvidence(candidate, [{ filePath: "src/load.ts", source }]))
      .toBeUndefined();
  });
});

const RULE = "jev/no-swallowed-error";

class FakeEvaluator implements Evaluator {
  requests: EvaluationRequest[] = [];

  constructor(private readonly scores: number[]) {}

  async evaluate(request: EvaluationRequest): Promise<Record<string, number>> {
    this.requests.push(request);
    const ids = Object.keys(request.questions);
    return Object.fromEntries(ids.map((id, index) => [
      id,
      this.scores[index] ?? this.scores[0] ?? 0.5,
    ]));
  }
}

function walkCandidate(files: ProjectFile[]): Candidate {
  const owner = files[0];
  expect(owner).toBeDefined();
  if (!owner) throw new Error("Fixture has no changed file.");
  const candidate = extractCandidates(owner.filePath, owner.source)
    .find(({ kind, source }) => kind === "function" && source.includes("walk("));
  expect(candidate).toBeDefined();
  if (!candidate) throw new Error("Fixture has no walk function.");
  return candidate;
}

async function judgeWalk(
  name: string,
  paths: string[],
  score: number,
) {
  const rule = defaultConfig.rules[RULE];
  expect(rule).toBeDefined();
  if (!rule) throw new Error("Rule is missing from the default config.");
  const config: JevLintConfig = { rules: { [RULE]: rule } };
  const files = await project(name, paths);
  const changed = files[0];
  expect(changed).toBeDefined();
  if (!changed) throw new Error("Fixture has no changed file.");
  const evaluator = new FakeEvaluator([score]);
  const result = await analyzeFileWithFailures({
    filePath: changed.filePath,
    source: changed.source,
    changedLines: [{ start: 1, end: changed.source.split("\n").length }],
    config,
    projectFiles: files,
  }, evaluator);
  return { result, evaluator };
}

describe("swallowed error kind-aware silence", () => {
  it("keeps the reframed proposition free of cutoff language", () => {
    const rule = defaultConfig.rules[RULE];
    expect(rule).toMatchObject({
      scope: "function",
      question: expect.objectContaining({
        instructions: expect.objectContaining({
          question: expect.stringContaining("without examining which error"),
        }),
      }),
      message: expect.any(String),
    });
    expect(rule).not.toHaveProperty("threshold");
    expect(rule).not.toHaveProperty("severity");
    expect(JSON.stringify(rule)).not.toMatch(/threshold|cutoff|pass\/fail|band/i);
  });

  it("records the absence-family guard as a counter-signal fact", async () => {
    const files = await project("swallowed-error-absence-walk", [
      "src/walk.ts",
      "src/coverage.ts",
      "src/app.ts",
    ]);

    expect(buildSwallowedErrorEvidence(walkCandidate(files), files)).toMatchObject({
      function: { name: "walk", exported: true },
      handlers: [{
        caught: "error",
        guardsAbsenceKind: true,
        absenceGuard: expect.stringContaining("ENOENT"),
        emptyReturns: expect.arrayContaining([expect.stringContaining("return [];")]),
      }],
    });
  });

  it("records the reason-carrying skip as mitigation facts", async () => {
    const files = await project("swallowed-error-absence-walk", [
      "src/walk.ts",
      "src/coverage.ts",
      "src/app.ts",
    ]);

    expect(buildSwallowedErrorEvidence(walkCandidate(files), files)).toMatchObject({
      handlers: [{
        surfacedReason: expect.stringContaining("reason"),
        stderrWrites: [expect.stringContaining("process.stderr.write")],
        completenessFlips: [expect.stringContaining("coverage.complete = false")],
      }],
    });
  });

  it("records omission facts for the bare skip", async () => {
    const files = await project("swallowed-error-bare-skip", [
      "src/walk.ts",
      "src/app.ts",
    ]);

    expect(buildSwallowedErrorEvidence(walkCandidate(files), files)).toMatchObject({
      function: { name: "walk", exported: true },
      handlers: [{
        caught: null,
        usesCaughtError: false,
        guardsAbsenceKind: false,
        absenceGuard: null,
        emptyReturns: [expect.stringContaining("return [];")],
        surfacedReason: null,
        stderrWrites: [],
        completenessFlips: [],
      }],
    });
  });

  it("recognizes not-found-shaped helper guards", () => {
    const source = `
      export async function readConfig(path: string) {
        try {
          return await fs.readFile(path, "utf8");
        } catch (error) {
          if (isNotFound(error)) return null;
          throw error;
        }
      }
    `;
    const candidate = extractCandidates("src/config.ts", source)[0];
    expect(candidate).toBeDefined();
    if (!candidate) return;

    expect(buildSwallowedErrorEvidence(candidate, [{ filePath: "src/config.ts", source }]))
      .toMatchObject({
        handlers: [{
          guardsAbsenceKind: true,
          absenceGuard: expect.stringContaining("isNotFound(error)"),
        }],
      });
  });

  it("carries kind-aware evidence through a fake evaluator with raw scores", async () => {
    const mitigated = await judgeWalk("swallowed-error-absence-walk", [
      "src/walk.ts",
      "src/coverage.ts",
      "src/app.ts",
    ], 0.22);
    expect(mitigated.result.failures).toEqual([]);
    expect(mitigated.result.judgments.map(({ ruleId }) => ruleId)).toEqual([RULE]);
    expect(mitigated.result.judgments[0]?.probability).toBe(0.22);
    expect(mitigated.evaluator.requests[0]?.state.candidates[0]?.evidence?.[RULE])
      .toMatchObject({
        handlers: [expect.objectContaining({
          guardsAbsenceKind: true,
          surfacedReason: expect.stringContaining("reason"),
        })],
      });

    const bare = await judgeWalk("swallowed-error-bare-skip", [
      "src/walk.ts",
      "src/app.ts",
    ], 0.81);
    expect(bare.result.failures).toEqual([]);
    expect(bare.result.judgments.map(({ ruleId }) => ruleId)).toEqual([RULE]);
    expect(bare.result.judgments[0]?.probability).toBe(0.81);
    expect(bare.evaluator.requests[0]?.state.candidates[0]?.evidence?.[RULE])
      .toMatchObject({
        handlers: [expect.objectContaining({
          guardsAbsenceKind: false,
          surfacedReason: null,
        })],
      });
  });

  it("leaves existing fixtures without kind or mitigation facts", async () => {
    const cases: [string, string[]][] = [
      ["swallowed-error-positive", ["src/publish-invoice.ts", "src/services.ts", "src/billing.ts"]],
      ["swallowed-error-negative", ["src/store-receipt.ts", "src/receipt-store.ts", "src/checkout.ts"]],
      ["swallowed-error-legitimate", ["src/delete-account.ts", "src/services.ts", "src/settings.ts"]],
      ["swallowed-error-ambiguous", ["src/load-profile.ts", "src/services.ts", "src/profile-page.ts"]],
    ];
    for (const [name, paths] of cases) {
      const files = await project(name, paths);
      const owner = files[0];
      expect(owner).toBeDefined();
      if (!owner) continue;
      const candidate = extractCandidates(owner.filePath, owner.source)
        .find(({ kind }) => kind === "function");
      expect(candidate).toBeDefined();
      if (!candidate) continue;
      expect(buildSwallowedErrorEvidence(candidate, files)).toMatchObject({
        handlers: [expect.objectContaining({
          guardsAbsenceKind: false,
          absenceGuard: null,
          surfacedReason: null,
          stderrWrites: [],
          completenessFlips: [],
        })],
      });
    }
  });
});
