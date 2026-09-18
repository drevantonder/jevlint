import { readFile } from "node:fs/promises";
import { describe, expect, it } from "vitest";
import { analyzeFileWithFailures } from "../src/analyze.js";
import { extractCandidates } from "../src/candidates.js";
import { defaultConfig } from "../src/config.js";
import { buildRuleEvidence } from "../src/evidence/index.js";
import { buildIndiscriminableErrorEvidence } from "../src/evidence/indiscriminable-error.js";
import type {
  Candidate,
  EvaluationRequest,
  Evaluator,
  JevLintConfig,
  ProjectFile,
} from "../src/types.js";

const RULE = "jev/no-indiscriminable-error";
const repositories = new URL("./fixtures/repositories/", import.meta.url);

async function project(name: string, paths: string[]): Promise<ProjectFile[]> {
  return Promise.all(paths.map(async (filePath) => ({
    filePath,
    source: await readFile(new URL(`${name}/${filePath}`, repositories), "utf8"),
  })));
}

function functionCandidate(files: ProjectFile[], snippet: string): Candidate {
  const candidates = files.flatMap((file) =>
    extractCandidates(file.filePath, file.source)
      .map((candidate) => ({ candidate, file }))
  );
  const hit = candidates.find(({ candidate }) =>
    candidate.kind === "function" && candidate.source.includes(snippet)
  );
  expect(hit).toBeDefined();
  if (!hit) throw new Error(`Fixture has no function containing ${snippet}.`);
  return hit.candidate;
}

class StubEvaluator implements Evaluator {
  async evaluate(request: EvaluationRequest): Promise<Record<string, number>> {
    return Object.fromEntries(Object.keys(request.questions).map((id) => [id, 0.5]));
  }
}

describe("indiscriminable error evidence", () => {
  it("keeps its proposition while gaining a builder", () => {
    expect(defaultConfig.rules[RULE]).toMatchObject({
      scope: "function",
      question: expect.objectContaining({
        instructions: expect.objectContaining({
          question: "Does this change throw or propagate an error callers cannot discriminate, where distinct failures need distinct handling?",
        }),
      }),
      message: "This error gives callers no way to tell failures apart.",
    });
  });

  it("flags bare errors for distinct failures plus the branching caller", async () => {
    const files = await project("indiscriminable-error-positive", [
      "src/config.ts",
      "src/service.ts",
    ]);

    const result = buildRuleEvidence(RULE, functionCandidate(files, "loadConfig"), files);

    expect(result).toEqual({ handled: true, evidence: expect.any(Object) });
    if (!result.handled) return;
    expect(result.evidence).toMatchObject({
      function: { name: "loadConfig", exported: true },
      thrownErrors: [
        {
          operation: 'throw new Error("something went wrong");',
          thrownType: "Error",
          kind: "indiscriminable",
          isBareError: true,
          hasCode: false,
          hasCause: false,
          hasStatus: false,
          isGenericMessage: true,
          referencesCaughtError: false,
        },
        {
          operation: 'throw new Error("something went wrong");',
          thrownType: "Error",
          kind: "indiscriminable",
          isBareError: true,
          hasCode: false,
          hasCause: false,
          hasStatus: false,
        },
      ],
      rejections: [],
      repository: {
        callers: [
          expect.objectContaining({ filePath: "src/service.ts" }),
        ],
        discriminatingHandlers: [
          expect.objectContaining({
            filePath: "src/service.ts",
            checks: expect.arrayContaining(["code", "instanceof"]),
          }),
        ],
      },
    });
  });

  it("marks subclassed cause-linked throws as discriminated with no branching caller", async () => {
    const files = await project("indiscriminable-error-negative", [
      "src/config.ts",
      "src/service.ts",
    ]);

    const evidence = buildIndiscriminableErrorEvidence(
      functionCandidate(files, "loadConfig"),
      files,
    );

    expect(evidence?.thrownErrors).toEqual([
      expect.objectContaining({
        thrownType: "ConfigNotFoundError",
        kind: "discriminated",
        isBareError: false,
        hasCause: true,
        referencesCaughtError: true,
      }),
      expect.objectContaining({
        thrownType: "ConfigParseError",
        kind: "discriminated",
        hasCause: true,
      }),
    ]);
    expect(evidence?.repository.discriminatingHandlers).toEqual([]);
  });

  it("marks bare rethrows and empty rejections without confusing them", () => {
    const source = `export function relay(key: string): Promise<string> {
      try {
        return Promise.resolve(key);
      } catch (err) {
        throw err;
      }
    }
    export function fail(): Promise<string> {
      return Promise.reject();
    }`;
    const candidates = extractCandidates("src/relay.ts", source);
    const relay = candidates.find(({ source: text }) => text.includes("throw err"));
    const fail = candidates.find(({ source: text }) => text.includes("Promise.reject"));
    expect(relay).toBeDefined();
    expect(fail).toBeDefined();
    if (!relay || !fail) return;
    const files: ProjectFile[] = [{ filePath: "src/relay.ts", source }];

    expect(buildIndiscriminableErrorEvidence(relay, files)?.thrownErrors).toEqual([
      expect.objectContaining({ kind: "bare-rethrow", referencesCaughtError: true }),
    ]);
    expect(buildIndiscriminableErrorEvidence(fail, files)?.rejections).toEqual([
      expect.objectContaining({ kind: "indiscriminable", thrownType: null }),
    ]);
  });

  it("abstains when the function raises nothing", () => {
    const source = `export function add(left: number, right: number): number {
      return left + right;
    }`;
    const candidate = extractCandidates("src/add.ts", source)[0];
    expect(candidate).toBeDefined();
    if (!candidate) return;

    expect(buildIndiscriminableErrorEvidence(
      candidate,
      [{ filePath: "src/add.ts", source }],
    )).toBeUndefined();
  });

  it("abstains for non-function candidates", async () => {
    const files = await project("indiscriminable-error-positive", ["src/config.ts"]);
    const owner = files[0];
    expect(owner).toBeDefined();
    if (!owner) return;
    for (const candidate of extractCandidates(owner.filePath, owner.source)) {
      if (candidate.kind === "function") continue;
      expect(buildIndiscriminableErrorEvidence(candidate, files)).toBeUndefined();
    }
  });

  it("sends raising functions to evaluation with raw scores and abstains the rest", async () => {
    const rule = defaultConfig.rules[RULE];
    expect(rule).toBeDefined();
    if (!rule) return;
    const config: JevLintConfig = { rules: { [RULE]: rule } };
    const evaluator = new StubEvaluator();

    const raisingSource = `export function loadConfig(path: string): string {
      try {
        return "config";
      } catch (err) {
        throw new Error("something went wrong");
      }
    }
`;
    const raising = await analyzeFileWithFailures({
      filePath: "src/config.ts",
      source: raisingSource,
      changedLines: [{ start: 1, end: 7 }],
      config,
      projectFiles: [{ filePath: "src/config.ts", source: raisingSource }],
    }, evaluator);
    expect(raising.judgments.map(({ ruleId }) => ruleId)).toEqual([RULE]);
    expect(raising.judgments[0]).toMatchObject({ probability: 0.5 });

    const quietSource = `export function add(left: number, right: number): number {
      return left + right;
    }
`;
    const quiet = await analyzeFileWithFailures({
      filePath: "src/add.ts",
      source: quietSource,
      changedLines: [{ start: 1, end: 3 }],
      config,
      projectFiles: [{ filePath: "src/add.ts", source: quietSource }],
    }, evaluator);
    expect(quiet.judgments).toEqual([]);
    expect(quiet.abstentions).toEqual([
      { ruleId: RULE, candidateKind: "function", count: 1 },
    ]);
  });
});
