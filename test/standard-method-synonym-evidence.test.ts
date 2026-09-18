import { readFile } from "node:fs/promises";
import { describe, expect, it } from "vitest";
import { analyzeFileWithFailures } from "../src/analyze.js";
import { extractCandidates } from "../src/candidates.js";
import { defaultConfig } from "../src/config.js";
import { buildRuleEvidence } from "../src/evidence/index.js";
import { buildStandardMethodSynonymEvidence } from "../src/evidence/standard-method-synonym.js";
import type {
  Candidate,
  EvaluationRequest,
  Evaluator,
  JevLintConfig,
  ProjectFile,
} from "../src/types.js";

const RULE = "jev/no-standard-method-synonym";
const repositories = new URL("./fixtures/repositories/", import.meta.url);

async function project(name: string, paths: string[]): Promise<ProjectFile[]> {
  return Promise.all(paths.map(async (filePath) => ({
    filePath,
    source: await readFile(new URL(`${name}/${filePath}`, repositories), "utf8"),
  })));
}

function abstractionCandidate(files: ProjectFile[]): Candidate {
  const candidates = files.flatMap((file) =>
    extractCandidates(file.filePath, file.source)
      .map((candidate) => ({ candidate, file }))
  );
  const hit = candidates.find(({ candidate }) => candidate.kind === "abstraction");
  expect(hit).toBeDefined();
  if (!hit) throw new Error("Fixture has no abstraction candidate.");
  return hit.candidate;
}

class RecordingEvaluator implements Evaluator {
  requests: EvaluationRequest[] = [];
  constructor(private readonly rawScore: number) {}
  async evaluate(request: EvaluationRequest): Promise<Record<string, number>> {
    this.requests.push(request);
    return Object.fromEntries(Object.keys(request.questions).map((id) => [id, this.rawScore]));
  }
}

describe("standard method synonym evidence", () => {
  it("keeps its proposition while gaining a builder", () => {
    expect(defaultConfig.rules[RULE]).toMatchObject({
      scope: "abstraction",
      question: expect.objectContaining({
        instructions: expect.objectContaining({
          question: expect.stringContaining("invent a synonym"),
        }),
      }),
      message: "One resource operation is expressed with two verbs for the same standard-method concept.",
    });
  });

  it("pairs two read-family verbs on one resource stem", async () => {
    const files = await project("standard-method-synonym-positive", ["src/users.ts"]);

    const result = buildRuleEvidence(RULE, abstractionCandidate(files), files);

    expect(result).toEqual({ handled: true, evidence: expect.any(Object) });
    if (!result.handled) return;
    expect(result.evidence).toMatchObject({
      module: { filePath: "src/users.ts" },
      pairs: [
        {
          stem: "user",
          verbs: [
            expect.objectContaining({ verb: "fetch", name: "fetchUser", exported: true }),
            expect.objectContaining({ verb: "get", name: "getUser", exported: true }),
          ],
        },
      ],
    });
    // SAFETY: The dispatch contract returns this builder's pair object for this rule.
    const pairs = (result.evidence as { pairs: { stem: string; verbs: { verb: string }[] }[] }).pairs;
    expect(pairs).toHaveLength(1);
    // createUser is a distinct standard method, not a read synonym; the lone
    // getOrder stem never pairs.
    expect(pairs[0]?.verbs.map(({ verb }) => verb).sort()).toEqual(["fetch", "get"]);
  });

  it("abstains when no stem carries two read-family verbs", async () => {
    const files = await project("standard-method-synonym-negative", ["src/store.ts"]);

    // A lone fetchUser with no get sibling is house style, and get/delete on
    // the order stem are distinct standard methods.
    expect(buildStandardMethodSynonymEvidence(abstractionCandidate(files), files))
      .toBeUndefined();
  });

  it("abstains for non-abstraction candidates", async () => {
    const files = await project("standard-method-synonym-positive", ["src/users.ts"]);
    const candidate = extractCandidates(files[0]?.filePath ?? "", files[0]?.source ?? "")
      .find(({ kind }) => kind === "function");
    expect(candidate).toBeDefined();
    if (!candidate) return;

    expect(buildStandardMethodSynonymEvidence(candidate, files)).toBeUndefined();
  });

  it("reports the evaluator raw score untouched", async () => {
    const rule = defaultConfig.rules[RULE];
    expect(rule).toBeDefined();
    if (!rule) return;
    const config: JevLintConfig = { rules: { [RULE]: rule } };
    const evaluator = new RecordingEvaluator(0.78);

    const files = await project("standard-method-synonym-positive", ["src/users.ts"]);
    const owner = files[0];
    expect(owner).toBeDefined();
    if (!owner) return;
    const result = await analyzeFileWithFailures({
      filePath: owner.filePath,
      source: owner.source,
      changedLines: [{ start: 1, end: 12 }],
      config,
      projectFiles: files,
    }, evaluator);

    expect(result.judgments.map(({ ruleId }) => ruleId)).toEqual([RULE]);
    // The raw evaluator score flows through untouched; this rule never
    // passes, fails, or bands its probability.
    expect(result.judgments[0]?.probability).toBe(0.78);
    expect(evaluator.requests).toHaveLength(1);
    expect(JSON.stringify(evaluator.requests[0]?.state.candidates)).toContain("fetchUser");
  });

  it("abstains the house-style module without calling for judgment", async () => {
    const rule = defaultConfig.rules[RULE];
    expect(rule).toBeDefined();
    if (!rule) return;
    const config: JevLintConfig = { rules: { [RULE]: rule } };
    const evaluator = new RecordingEvaluator(0.13);

    const files = await project("standard-method-synonym-negative", ["src/store.ts"]);
    const owner = files[0];
    expect(owner).toBeDefined();
    if (!owner) return;
    const result = await analyzeFileWithFailures({
      filePath: owner.filePath,
      source: owner.source,
      changedLines: [{ start: 1, end: 12 }],
      config,
      projectFiles: files,
    }, evaluator);

    expect(result.judgments).toEqual([]);
    expect(result.abstentions).toEqual([
      { ruleId: RULE, candidateKind: "abstraction", count: 1 },
    ]);
  });
});
