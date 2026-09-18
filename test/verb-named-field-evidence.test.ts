import { readFile } from "node:fs/promises";
import { describe, expect, it } from "vitest";
import { analyzeFileWithFailures } from "../src/analyze.js";
import { extractCandidates } from "../src/candidates.js";
import { defaultConfig } from "../src/config.js";
import { buildRuleEvidence } from "../src/evidence/index.js";
import { buildVerbNamedFieldEvidence } from "../src/evidence/verb-named-field.js";
import type {
  Candidate,
  EvaluationRequest,
  Evaluator,
  JevLintConfig,
  ProjectFile,
} from "../src/types.js";

const RULE = "jev/no-verb-named-field";
const repositories = new URL("./fixtures/repositories/", import.meta.url);

async function project(name: string, paths: string[]): Promise<ProjectFile[]> {
  return Promise.all(paths.map(async (filePath) => ({
    filePath,
    source: await readFile(new URL(`${name}/${filePath}`, repositories), "utf8"),
  })));
}

function abstractionCandidate(files: ProjectFile[], excerpt: string): Candidate {
  const candidates = files.flatMap((file) => extractCandidates(file.filePath, file.source));
  const candidate = candidates.find(({ kind, source }) =>
    kind === "abstraction" && source.includes(excerpt)
  );
  expect(candidate).toBeDefined();
  if (!candidate) throw new Error(`Fixture has no abstraction containing ${excerpt}.`);
  return candidate;
}

class FakeEvaluator implements Evaluator {
  constructor(readonly rawScore: number) {}
  async evaluate(request: EvaluationRequest): Promise<Record<string, number>> {
    return Object.fromEntries(Object.keys(request.questions).map((id) => [id, this.rawScore]));
  }
}

describe("verb named field evidence", () => {
  it("keeps its proposition without ranking machinery", () => {
    expect(defaultConfig.rules[RULE]).toMatchObject({
      scope: "abstraction",
      question: expect.objectContaining({
        instructions: expect.objectContaining({
          question: "Does this stored type field or property use a verb or action phrase implying computation, where the member is plain stored state with no such behavior?",
        }),
      }),
      message: "This field name implies computation its stored value does not provide.",
    });
    expect(defaultConfig.rules[RULE]).not.toHaveProperty("threshold");
    expect(defaultConfig.rules[RULE]).not.toHaveProperty("severity");
  });

  it("finds verb-named stored fields beside an excluded callback", async () => {
    const files = await project("verb-named-field-smelly", ["src/export.ts"]);

    const result = buildRuleEvidence(RULE, abstractionCandidate(files, "ExportJob"), files);

    expect(result).toEqual({ handled: true, evidence: expect.any(Object) });
    if (!result.handled) return;
    expect(result.evidence).toMatchObject({
      abstraction: { name: "ExportJob", kind: "interface" },
      findings: expect.arrayContaining([
        expect.objectContaining({ name: "fetchBatch", verb: "fetch", declaredType: "string" }),
        expect.objectContaining({ name: "updatePayload", verb: "update" }),
      ]),
      excluded: expect.arrayContaining([
        expect.objectContaining({ name: "saveChanges", reason: "function-typed" }),
      ]),
      memberCount: 6,
    });
    // SAFETY: The dispatch contract returns this builder's findings object for this rule.
    const findings = (result.evidence as { findings: { name: string }[] }).findings;
    expect(findings.map(({ name }) => name).sort()).toEqual(["fetchBatch", "updatePayload"]);
  });

  it("finds a verb-named member in a type alias while excluding the callback", async () => {
    const files = await project("verb-named-field-smelly", ["src/draft.ts"]);

    const evidence = buildVerbNamedFieldEvidence(
      abstractionCandidate(files, "DraftState"),
      files,
    );

    expect(evidence).toMatchObject({
      abstraction: { name: "DraftState", kind: "type-alias" },
      findings: [{ name: "mergeResult", verb: "merge", declaredType: "string" }],
      excluded: [{ name: "applyPatch", reason: "function-typed" }],
      memberCount: 4,
    });
  });

  it("finds an unannotated verb-named class property while excluding the closure", async () => {
    const files = await project("verb-named-field-smelly", ["src/cache.ts"]);

    const evidence = buildVerbNamedFieldEvidence(
      abstractionCandidate(files, "RenderCache"),
      files,
    );

    expect(evidence).toMatchObject({
      abstraction: { name: "RenderCache", kind: "class" },
      findings: [{ name: "computeKey", verb: "compute", declaredType: null }],
      excluded: [{ name: "refresh", reason: "function-typed" }],
    });
  });

  it("abstains when only nouns, predicates, and callbacks remain", async () => {
    const files = await project("verb-named-field-smelly", ["src/clean.ts"]);

    expect(buildVerbNamedFieldEvidence(abstractionCandidate(files, "SelectionState"), files))
      .toBeUndefined();
  });

  it("abstains for non-abstraction candidates", async () => {
    const source = "export function fetchBatch(id: string): string {\n"
      + "  return id.trim();\n"
      + "}\n";
    const candidate = extractCandidates("src/jobs.ts", source)
      .find(({ kind }) => kind === "function");
    expect(candidate).toBeDefined();
    if (!candidate) return;

    expect(buildVerbNamedFieldEvidence(candidate, [{ filePath: "src/jobs.ts", source }]))
      .toBeUndefined();
  });

  it("reports the evaluator's raw score with the evidence attached", async () => {
    const rule = defaultConfig.rules[RULE];
    expect(rule).toBeDefined();
    if (!rule) return;
    const config: JevLintConfig = { rules: { [RULE]: rule } };
    const files = await project("verb-named-field-smelly", ["src/export.ts"]);
    const owner = files[0];
    expect(owner).toBeDefined();
    if (!owner) return;

    const smelly = await analyzeFileWithFailures({
      filePath: owner.filePath,
      source: owner.source,
      changedLines: [{ start: 1, end: owner.source.split("\n").length }],
      config,
      projectFiles: files,
    }, new FakeEvaluator(0.82));

    expect(smelly.judgments.map(({ ruleId }) => ruleId)).toEqual([RULE]);
    expect(smelly.judgments[0]).toMatchObject({
      probability: 0.82,
      evidence: expect.objectContaining({
        findings: expect.arrayContaining([
          expect.objectContaining({ name: "fetchBatch" }),
        ]),
      }),
    });

    const cleanFiles = await project("verb-named-field-smelly", ["src/clean.ts"]);
    const cleanOwner = cleanFiles[0];
    expect(cleanOwner).toBeDefined();
    if (!cleanOwner) return;
    const clean = await analyzeFileWithFailures({
      filePath: cleanOwner.filePath,
      source: cleanOwner.source,
      changedLines: [{ start: 1, end: cleanOwner.source.split("\n").length }],
      config,
      projectFiles: cleanFiles,
    }, new FakeEvaluator(0.82));

    expect(clean.judgments).toEqual([]);
    expect(clean.abstentions).toEqual([
      { ruleId: RULE, candidateKind: "abstraction", count: 1 },
    ]);
  });
});
