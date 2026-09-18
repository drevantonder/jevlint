import { readFile } from "node:fs/promises";
import { describe, expect, it } from "vitest";
import { analyzeFile } from "../src/analyze.js";
import { extractCandidates } from "../src/candidates.js";
import { buildTautologicalTestEvidence } from "../src/evidence/tautological-test.js";
import type {
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

function testCandidate(owner: ProjectFile, needle: string) {
  return extractCandidates(owner.filePath, owner.source)
    .filter(({ kind, source }) => kind === "function" && source.includes(needle))
    .sort((left, right) => left.source.length - right.source.length)[0];
}

type TautologyProbe = {
  instructions?: {
    evidence?: string | null;
  };
};

type RuleEvidenceProbe = {
  tautological?: string[];
};

/** Fake evaluator: scores from structural evidence alone, no live Jev calls.
 * Evidence travels under request.state.candidates[i].evidence[ruleId]; the
 * raw score for each question comes from its own candidate's evidence.
 * Scores flow straight into judgments; nothing is cut off. */
class EvidenceScoringEvaluator implements Evaluator {
  requests: EvaluationRequest[] = [];

  async evaluate(request: EvaluationRequest): Promise<Record<string, number>> {
    this.requests.push(request);
    return Object.fromEntries(
      Object.entries(request.questions).map(([id, question]) => {
        // SAFETY: jevlint builds every evaluation question with its own
        // QuestionInstructions record carrying the evidence path, so viewing
        // instructions through the probe type is sound within this suite.
        const instructions = (question as TautologyProbe).instructions;
        const match = /candidates\[(\d+)\]/.exec(instructions?.evidence ?? "");
        const candidate = match ? request.state.candidates[Number(match[1])] : undefined;
        // SAFETY: buildTautologicalTestEvidence emits tautological as a
        // string array, and Array.isArray below admits only genuine arrays.
        const evidence = (candidate?.evidence?.["jev/no-tautological-test"] ?? {}) as RuleEvidenceProbe;
        const fires = Array.isArray(evidence.tautological) && evidence.tautological.length > 0;
        return [id, fires ? 0.82 : 0.14];
      }),
    );
  }
}

const config: JevLintConfig = {
  rules: {
    "jev/no-tautological-test": {
      scope: "function",
      category: "maintainability",
      question: { instructions: "Is the expected value recomputed from the exercised computation?" },
      message: "Tautological test.",
    },
  },
};

function changedLines(source: string) {
  return [{ start: 1, end: source.split("\n").length }];
}

describe("tautological test evidence", () => {
  it("flags an expectation recomputed from the exercised computation", async () => {
    const projectFiles = await project("tautological-recompute", [
      "test/math.test.ts",
      "src/math.ts",
    ]);
    const owner = projectFiles[0];
    expect(owner).toBeDefined();
    if (!owner) return;
    const candidate = testCandidate(owner, "toBe(a + b)");
    expect(candidate).toBeDefined();
    if (!candidate) return;

    expect(buildTautologicalTestEvidence(candidate, projectFiles)).toMatchObject({
      function: { title: "adds two numbers" },
      assertions: [
        expect.objectContaining({
          matcher: "toBe",
          actual: "add(a, b)",
          expected: "a + b",
          oracle: "same-computation",
          sharedIdentifiers: expect.arrayContaining(["a", "b"]),
        }),
      ],
      tautological: [expect.stringContaining("a + b")],
      companionOracleCount: 0,
    });
  });

  it("flags node assert recomputation and constant self-comparison", async () => {
    const projectFiles = await project("tautological-recompute", [
      "test/math.test.ts",
      "src/math.ts",
    ]);
    const owner = projectFiles[0];
    expect(owner).toBeDefined();
    if (!owner) return;

    const nodeAssert = testCandidate(owner, "strictEqual");
    expect(nodeAssert).toBeDefined();
    if (!nodeAssert) return;
    expect(buildTautologicalTestEvidence(nodeAssert, projectFiles)).toMatchObject({
      assertions: [
        expect.objectContaining({
          matcher: "strictEqual",
          oracle: "same-computation",
        }),
      ],
      tautological: [expect.stringContaining("a + b")],
    });

    const selfCompare = testCandidate(owner, "STATUS");
    expect(selfCompare).toBeDefined();
    if (!selfCompare) return;
    expect(buildTautologicalTestEvidence(selfCompare, projectFiles)).toMatchObject({
      assertions: [
        expect.objectContaining({
          actual: "STATUS",
          expected: "STATUS",
          oracle: "constant-self",
        }),
      ],
      tautological: [expect.stringContaining("STATUS")],
    });
  });

  it("flags a bare snapshot with no independent oracle", async () => {
    const projectFiles = await project("tautological-snapshot", [
      "test/render.test.ts",
      "src/render.ts",
    ]);
    const owner = projectFiles[0];
    expect(owner).toBeDefined();
    if (!owner) return;
    const candidate = testCandidate(owner, "toMatchSnapshot");
    expect(candidate).toBeDefined();
    if (!candidate) return;

    expect(buildTautologicalTestEvidence(candidate, projectFiles)).toMatchObject({
      assertions: [
        expect.objectContaining({
          matcher: "toMatchSnapshot",
          expected: null,
          oracle: "snapshot-without-oracle",
        }),
      ],
      tautological: [expect.stringContaining("toMatchSnapshot")],
      companionOracleCount: 0,
    });
  });

  it("reports a literal worked example as an independent oracle with nothing tautological", async () => {
    const projectFiles = await project("tautological-oracle", [
      "test/math.test.ts",
      "src/math.ts",
    ]);
    const owner = projectFiles[0];
    expect(owner).toBeDefined();
    if (!owner) return;
    const candidate = testCandidate(owner, "toBe(3)");
    expect(candidate).toBeDefined();
    if (!candidate) return;

    expect(buildTautologicalTestEvidence(candidate, projectFiles)).toMatchObject({
      assertions: [
        expect.objectContaining({
          actual: "add(1, 2)",
          expected: "3",
          oracle: "independent-oracle",
        }),
      ],
      tautological: [],
      companionOracleCount: 1,
    });
  });

  it("abstains for production files", async () => {
    const projectFiles = await project("tautological-recompute", [
      "test/math.test.ts",
      "src/math.ts",
    ]);
    const owner = projectFiles[1];
    expect(owner).toBeDefined();
    if (!owner) return;
    const candidate = extractCandidates(owner.filePath, owner.source)
      .find(({ kind }) => kind === "function");
    expect(candidate).toBeDefined();
    if (!candidate) return;

    expect(buildTautologicalTestEvidence(candidate, projectFiles)).toBeUndefined();
  });
});

describe("tautological test judgments via fake evaluator", () => {
  it("carries raw fake scores into judgments with no cutoff", async () => {
    const [recompute, oracle] = await Promise.all([
      project("tautological-recompute", ["test/math.test.ts", "src/math.ts"]),
      project("tautological-oracle", ["test/math.test.ts", "src/math.ts"]),
    ]);
    const recomputeOwner = recompute[0];
    const oracleOwner = oracle[0];
    expect(recomputeOwner).toBeDefined();
    expect(oracleOwner).toBeDefined();
    if (!recomputeOwner || !oracleOwner) return;
    const evaluator = new EvidenceScoringEvaluator();

    const hot = await analyzeFile(
      {
        filePath: recomputeOwner.filePath,
        source: recomputeOwner.source,
        changedLines: changedLines(recomputeOwner.source),
        config,
        projectFiles: recompute,
      },
      evaluator,
    );
    const hotHit = hot.find(({ probability }) => probability === 0.82);
    expect(hotHit).toMatchObject({
      ruleId: "jev/no-tautological-test",
      probability: 0.82,
      evidence: expect.objectContaining({
        tautological: expect.arrayContaining([expect.stringContaining("a + b")]),
      }),
    });

    const cold = await analyzeFile(
      {
        filePath: oracleOwner.filePath,
        source: oracleOwner.source,
        changedLines: changedLines(oracleOwner.source),
        config,
        projectFiles: oracle,
      },
      evaluator,
    );
    // Low-evidence judgments are still reported with their raw score: no cutoffs.
    expect(cold).toContainEqual(
      expect.objectContaining({
        ruleId: "jev/no-tautological-test",
        probability: 0.14,
      }),
    );
  });
});
