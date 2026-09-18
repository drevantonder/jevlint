import { readFile } from "node:fs/promises";
import { describe, expect, it } from "vitest";
import { analyzeFileWithFailures } from "../src/analyze.js";
import { extractCandidates } from "../src/candidates.js";
import { defaultConfig } from "../src/config.js";
import { buildRuleEvidence } from "../src/evidence/index.js";
import { buildAnyWidenedInterfaceEvidence } from "../src/evidence/any-widened-interface.js";
import type {
  Candidate,
  EvaluationRequest,
  Evaluator,
  JevLintConfig,
  ProjectFile,
} from "../src/types.js";

const RULE = "jev/no-any-widened-interface";
const repositories = new URL("./fixtures/repositories/", import.meta.url);

async function project(name: string, paths: string[]): Promise<ProjectFile[]> {
  return Promise.all(paths.map(async (filePath) => ({
    filePath,
    source: await readFile(new URL(`${name}/${filePath}`, repositories), "utf8"),
  })));
}

function functionCandidate(files: ProjectFile[], excerpt: string): Candidate {
  const owner = files[0];
  expect(owner).toBeDefined();
  if (!owner) throw new Error("Fixture has no changed file.");
  const candidate = extractCandidates(owner.filePath, owner.source)
    .find(({ kind, source }) => kind === "function" && source.includes(excerpt));
  expect(candidate).toBeDefined();
  if (!candidate) throw new Error(`Fixture has no function containing ${excerpt}.`);
  return candidate;
}

class StubEvaluator implements Evaluator {
  async evaluate(request: EvaluationRequest): Promise<Record<string, number>> {
    return Object.fromEntries(Object.keys(request.questions).map((id) => [id, 0.5]));
  }
}

describe("any widened interface wiring", () => {
  it("ships as a function judgment without thresholds", () => {
    expect(defaultConfig.rules[RULE]).toMatchObject({
      scope: "function",
      message: expect.any(String),
    });
    expect(defaultConfig.rules[RULE]).not.toHaveProperty("threshold");
    expect(defaultConfig.rules[RULE]).not.toHaveProperty("severity");
  });

  it("flags any in caller-visible positions with a narrower type nearby", async () => {
    const files = await project("any-widened-interface-positive", [
      "src/users.ts",
      "src/roster.ts",
    ]);

    const result = buildRuleEvidence(RULE, functionCandidate(files, "formatUser"), files);

    expect(result).toEqual({ handled: true, evidence: expect.any(Object) });
    if (!result.handled) return;
    expect(result.evidence).toMatchObject({
      function: { name: "formatUser", exported: true },
      widenedPositions: [
        { position: "parameter", name: "user", annotation: "any" },
        { position: "return", annotation: "any" },
      ],
      genericConstraintAny: false,
      hasExplicitAnyDisable: false,
      narrowerAlternativesNearby: expect.arrayContaining(["User"]),
      repository: {
        callers: expect.arrayContaining([
          expect.objectContaining({ filePath: "src/roster.ts" }),
        ]),
      },
    });
  });

  it("records generic constraints and disable comments as documented exceptions", async () => {
    const files = await project("any-widened-interface-exception", ["src/wrap.ts"]);

    expect(buildAnyWidenedInterfaceEvidence(functionCandidate(files, "function wrap"), files))
      .toMatchObject({
        function: { name: "wrap", exported: true },
        widenedPositions: [],
        internalAnyNotes: expect.arrayContaining([
          expect.stringContaining("lastArgs"),
        ]),
        genericConstraintAny: true,
        hasExplicitAnyDisable: true,
      });
  });

  it("abstains when the signature is fully typed", async () => {
    const files = await project("any-widened-interface-negative", ["src/users.ts"]);

    expect(buildAnyWidenedInterfaceEvidence(
      functionCandidate(files, "formatUser"),
      files,
    )).toBeUndefined();
  });

  it("abstains for non-function candidates", async () => {
    const files = await project("any-widened-interface-positive", [
      "src/users.ts",
      "src/roster.ts",
    ]);
    const owner = files[0];
    expect(owner).toBeDefined();
    if (!owner) return;
    const candidate = extractCandidates(owner.filePath, owner.source)
      .find(({ kind }) => kind === "abstraction");
    expect(candidate).toBeDefined();
    if (!candidate) return;

    expect(buildAnyWidenedInterfaceEvidence(candidate, files)).toBeUndefined();
  });

  it("sends widened signatures to evaluation and abstains typed ones", async () => {
    const rule = defaultConfig.rules[RULE];
    expect(rule).toBeDefined();
    if (!rule) return;
    const config: JevLintConfig = { rules: { [RULE]: rule } };
    const evaluator = new StubEvaluator();

    const widenedSource = `export interface Item {\n  id: string;\n}\nexport function lookup(id: any): any {\n  return id;\n}\n`;
    const widened = await analyzeFileWithFailures({
      filePath: "src/lookup.ts",
      source: widenedSource,
      changedLines: [{ start: 1, end: 6 }],
      config,
      projectFiles: [{ filePath: "src/lookup.ts", source: widenedSource }],
    }, evaluator);
    expect(widened.judgments.map(({ ruleId }) => ruleId)).toEqual([RULE]);
    expect(widened.judgments[0]?.probability).toBe(0.5);
    expect(widened.abstentions).toEqual([]);

    const typedSource = `export interface Item {\n  id: string;\n}\nexport function lookup(id: string): Item | undefined {\n  return undefined;\n}\n`;
    const typed = await analyzeFileWithFailures({
      filePath: "src/lookup.ts",
      source: typedSource,
      changedLines: [{ start: 1, end: 6 }],
      config,
      projectFiles: [{ filePath: "src/lookup.ts", source: typedSource }],
    }, evaluator);
    expect(typed.judgments).toEqual([]);
    expect(typed.abstentions).toEqual([
      { ruleId: RULE, candidateKind: "function", count: 1 },
    ]);
  });
});
