import { readFile } from "node:fs/promises";
import { describe, expect, it } from "vitest";
import { analyzeFileWithFailures } from "../src/analyze.js";
import { extractCandidates } from "../src/candidates.js";
import { defaultConfig } from "../src/config.js";
import { buildRuleEvidence } from "../src/evidence/index.js";
import { buildCardinalityLyingTypeEvidence } from "../src/evidence/cardinality-lying-type.js";
import type { JsonValue } from "@typesafe-ai/sdk";
import type {
  Candidate,
  EvaluationRequest,
  Evaluator,
  JevLintConfig,
  ProjectFile,
} from "../src/types.js";

const RULE = "jev/no-cardinality-lying-type";
const repositories = new URL("./fixtures/repositories/", import.meta.url);

async function project(name: string, paths: string[]): Promise<ProjectFile[]> {
  return Promise.all(paths.map(async (filePath) => ({
    filePath,
    source: await readFile(new URL(`${name}/${filePath}`, repositories), "utf8"),
  })));
}

function abstractionCandidate(files: ProjectFile[], snippet: string): Candidate {
  const candidates = files.flatMap((file) =>
    extractCandidates(file.filePath, file.source)
      .map((candidate) => ({ candidate, file }))
  );
  const hit = candidates.find(({ candidate }) =>
    candidate.kind === "abstraction" && candidate.source.includes(snippet)
  );
  expect(hit).toBeDefined();
  if (!hit) throw new Error(`Fixture has no abstraction containing ${snippet}.`);
  return hit.candidate;
}

class StubEvaluator implements Evaluator {
  captured: Array<Record<string, JsonValue | undefined>> = [];
  constructor(private readonly rawScore: number) {}
  async evaluate(request: EvaluationRequest): Promise<Record<string, number>> {
    for (const candidate of request.state.candidates) {
      this.captured.push({ ...candidate.evidence });
    }
    return Object.fromEntries(Object.keys(request.questions).map((id) => [id, this.rawScore]));
  }
}

describe("cardinality lying type evidence", () => {
  it("keeps its proposition: a type name must not misstate its shape's cardinality", () => {
    expect(defaultConfig.rules[RULE]).toMatchObject({
      scope: "abstraction",
      question: expect.objectContaining({
        instructions: expect.objectContaining({
          question: "Does this type name promise a cardinality its declared shape contradicts?",
        }),
      }),
      message: "This type name misstates the cardinality of its shape.",
    });
  });

  it("fires on a plural interface holding one object, with use sites attached", async () => {
    const files = await project("cardinality-lying-type-smelly", [
      "src/users.ts",
      "src/greet.ts",
    ]);

    const result = buildRuleEvidence(
      RULE,
      abstractionCandidate(files, "interface Users"),
      files,
    );

    expect(result).toEqual({ handled: true, evidence: expect.any(Object) });
    if (!result.handled) return;
    expect(result.evidence).toMatchObject({
      abstraction: { name: "Users", kind: "interface" },
      morphology: { token: "Users", form: "plural", asserted: "collection" },
      declared: { form: "single", detail: "object" },
      mismatch: "plural-name-single-shape",
      established: false,
      usages: expect.arrayContaining([
        expect.objectContaining({ filePath: "src/greet.ts" }),
      ]),
      importingModules: ["src/greet.ts"],
    });
  });

  it("fires on a singular alias over an array", async () => {
    const files = await project("cardinality-lying-type-smelly", [
      "src/users.ts",
      "src/greet.ts",
    ]);

    const evidence = buildCardinalityLyingTypeEvidence(
      abstractionCandidate(files, "type Tag"),
      files,
    );

    expect(evidence).toMatchObject({
      abstraction: { name: "Tag", kind: "type" },
      morphology: { form: "singular", asserted: "single" },
      declared: { form: "collection", detail: "array" },
      mismatch: "singular-name-collection-shape",
    });
  });

  it("abstains where name and shape agree, including News and Data exemptions", async () => {
    const files = await project("cardinality-lying-type-clean", [
      "src/catalog.ts",
      "src/feed.ts",
    ]);

    for (const snippet of ["type Users", "interface News", "type News", "type Data"]) {
      expect(
        buildCardinalityLyingTypeEvidence(abstractionCandidate(files, snippet), files),
        snippet,
      ).toBeUndefined();
    }
  });

  it("abstains for an established Settings bag but fires for a lone one", async () => {
    const established = await project("cardinality-lying-type-established", [
      "src/settings.ts",
      "src/app.ts",
      "src/prefs.ts",
    ]);
    const owner = established.find(({ filePath }) => filePath === "src/settings.ts");
    expect(owner).toBeDefined();
    if (!owner) return;
    const candidate = extractCandidates(owner.filePath, owner.source)
      .find(({ kind }) => kind === "abstraction");
    expect(candidate).toBeDefined();
    if (!candidate) return;
    expect(buildCardinalityLyingTypeEvidence(candidate, established)).toBeUndefined();

    const lone: ProjectFile[] = [{ filePath: "src/settings.ts", source: owner.source }];
    const loneCandidate = extractCandidates(owner.filePath, owner.source)
      .find(({ kind }) => kind === "abstraction");
    expect(loneCandidate).toBeDefined();
    if (!loneCandidate) return;
    const loneEvidence = buildCardinalityLyingTypeEvidence(loneCandidate, lone);
    expect(loneEvidence).toMatchObject({
      morphology: { form: "plural", conventionalBag: true },
      mismatch: "plural-name-single-shape",
      established: false,
    });
  });

  it("abstains for unclassifiable shapes and non-type candidates", () => {
    const source = "export interface Base {\n"
      + "  id: string;\n"
      + "}\n"
      + "export type Users = Base;\n"
      + "export type Group = Base & { label: string };\n"
      + "export function members(group: Group): Base[] {\n"
      + "  return [];\n"
      + "}\n";
    const files: ProjectFile[] = [{ filePath: "src/group.ts", source }];
    const candidates = extractCandidates("src/group.ts", source);

    for (const snippet of ["type Users = Base", "type Group"]) {
      const candidate = candidates.find(({ kind, source: text }) =>
        kind === "abstraction" && text.includes(snippet)
      );
      expect(candidate).toBeDefined();
      if (!candidate) continue;
      expect(buildCardinalityLyingTypeEvidence(candidate, files), snippet).toBeUndefined();
    }

    const fn = candidates.find(({ kind }) => kind === "function");
    expect(fn).toBeDefined();
    if (!fn) return;
    expect(buildCardinalityLyingTypeEvidence(fn, files)).toBeUndefined();
  });

  it("passes the raw evaluator score through with the evidence, judging nothing itself", async () => {
    const rule = defaultConfig.rules[RULE];
    expect(rule).toBeDefined();
    if (!rule) return;
    const config: JevLintConfig = { rules: { [RULE]: rule } };
    const evaluator = new StubEvaluator(0.62);

    const files = await project("cardinality-lying-type-smelly", [
      "src/users.ts",
      "src/greet.ts",
    ]);
    const changed = files[0];
    expect(changed).toBeDefined();
    if (!changed) return;
    const reviewed = await analyzeFileWithFailures({
      filePath: changed.filePath,
      source: changed.source,
      changedLines: [{ start: 1, end: changed.source.split("\n").length }],
      config,
      projectFiles: files,
    }, evaluator);

    expect(reviewed.judgments.map(({ ruleId }) => ruleId)).toEqual([RULE, RULE]);
    for (const judgment of reviewed.judgments) {
      expect(judgment.probability).toBe(0.62);
    }
    expect(evaluator.captured).toHaveLength(2);
    expect(evaluator.captured[0]?.[RULE]).toMatchObject({
      mismatch: "plural-name-single-shape",
    });
    expect(evaluator.captured[1]?.[RULE]).toMatchObject({
      mismatch: "singular-name-collection-shape",
    });

    const clean = await project("cardinality-lying-type-clean", [
      "src/catalog.ts",
      "src/feed.ts",
    ]);
    const cleanChanged = clean[0];
    expect(cleanChanged).toBeDefined();
    if (!cleanChanged) return;
    const cleanEvaluator = new StubEvaluator(0.62);
    const cleanReviewed = await analyzeFileWithFailures({
      filePath: cleanChanged.filePath,
      source: cleanChanged.source,
      changedLines: [{ start: 1, end: cleanChanged.source.split("\n").length }],
      config,
      projectFiles: clean,
    }, cleanEvaluator);

    expect(cleanReviewed.judgments).toEqual([]);
    expect(cleanReviewed.abstentions).toEqual([
      { ruleId: RULE, candidateKind: "abstraction", count: 2 },
    ]);
  });
});
