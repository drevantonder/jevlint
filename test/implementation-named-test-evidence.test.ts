import { readFile } from "node:fs/promises";
import { describe, expect, it } from "vitest";
import { analyzeFileWithFailures } from "../src/analyze.js";
import { extractCandidates } from "../src/candidates.js";
import { defaultConfig } from "../src/config.js";
import { buildRuleEvidence } from "../src/evidence/index.js";
import { buildImplementationNamedTestEvidence } from "../src/evidence/implementation-named-test.js";
import type {
  Candidate,
  EvaluationRequest,
  Evaluator,
  JevLintConfig,
  ProjectFile,
} from "../src/types.js";

const RULE = "jev/no-implementation-named-test";
const repositories = new URL("./fixtures/repositories/", import.meta.url);

async function project(name: string, paths: string[]): Promise<ProjectFile[]> {
  return Promise.all(paths.map(async (filePath) => ({
    filePath,
    source: await readFile(new URL(`${name}/${filePath}`, repositories), "utf8"),
  })));
}

function testCandidate(files: ProjectFile[], filePath: string, snippet: string): Candidate {
  const owner = files.find((file) => file.filePath === filePath);
  expect(owner).toBeDefined();
  if (!owner) throw new Error(`Fixture has no file ${filePath}.`);
  const candidates = extractCandidates(owner.filePath, owner.source)
    .filter(({ kind, source }) => kind === "function" && source.includes(snippet))
    .sort((left, right) => left.source.length - right.source.length);
  expect(candidates[0]).toBeDefined();
  if (!candidates[0]) throw new Error(`Fixture ${filePath} has no test containing ${snippet}.`);
  return candidates[0];
}

describe("implementation named test evidence", () => {
  it("keeps its proposition untouched while gaining a builder", () => {
    expect(defaultConfig.rules[RULE]).toMatchObject({
      scope: "function",
      question: expect.objectContaining({
        instructions: expect.objectContaining({
          question: "Does this test's title name the implementation under test instead of stating the behavior and expected outcome, so a failure tells the reader where, not what broke?",
        }),
      }),
      message: "This test's title names the implementation instead of the behavior it should pin.",
    });
  });

  it("fires on a title that is just the function name with the import and file stem beside it", async () => {
    const files = await project("implementation-named-positive", [
      "test/user.test.ts",
      "src/user.ts",
    ]);

    const result = buildRuleEvidence(
      RULE,
      testCandidate(files, "test/user.test.ts", 'const user = getUser("u1")'),
      files,
    );

    expect(result).toEqual({ handled: true, evidence: expect.any(Object) });
    if (!result.handled) return;
    expect(result.evidence).toMatchObject({
      test: { title: "getUser", runner: "it", filePath: "test/user.test.ts" },
      fileStem: "user",
      imports: expect.arrayContaining([
        expect.objectContaining({ local: "getUser", from: "../src/user.js" }),
        expect.objectContaining({ local: "createUser", from: "../src/user.js" }),
      ]),
      titles: expect.arrayContaining([
        { runner: "describe", title: "getUser" },
        { runner: "it", title: "getUser" },
        { runner: "it", title: "createUser" },
      ]),
      subjectCalls: [expect.stringContaining("getUser(")],
      assertionCalls: expect.arrayContaining([expect.stringContaining("toBe(")]),
    });
  });

  it("still builds evidence for a behavior-stating title so the evaluator can weigh the counter-signal", async () => {
    const files = await project("implementation-named-negative", [
      "test/user.test.ts",
      "src/user.ts",
    ]);

    expect(buildImplementationNamedTestEvidence(
      testCandidate(files, "test/user.test.ts", 'createUser({ name: "ada" })'),
      files,
    )).toMatchObject({
      test: { title: "rejects creation with a missing email", runner: "it" },
      fileStem: "user",
      subjectCalls: [expect.stringContaining("createUser(")],
    });
  });

  it("abstains for production files", async () => {
    const files = await project("implementation-named-positive", [
      "test/user.test.ts",
      "src/user.ts",
    ]);
    const owner = files.find((file) => file.filePath === "src/user.ts");
    expect(owner).toBeDefined();
    if (!owner) return;
    const candidate = extractCandidates(owner.filePath, owner.source)
      .find(({ kind }) => kind === "function");
    expect(candidate).toBeDefined();
    if (!candidate) return;

    expect(buildImplementationNamedTestEvidence(candidate, files)).toBeUndefined();
  });

  it("abstains when the title is not a string literal", async () => {
    const files = await project("implementation-named-negative", [
      "test/user.test.ts",
      "src/user.ts",
    ]);

    expect(buildImplementationNamedTestEvidence(
      testCandidate(files, "test/user.test.ts", 'getUser("u2")'),
      files,
    )).toBeUndefined();
  });

  it("carries the title facts through a fake evaluator with raw scores", async () => {
    const files = await project("implementation-named-positive", [
      "test/user.test.ts",
      "src/user.ts",
    ]);
    const owner = files.find((file) => file.filePath === "test/user.test.ts");
    expect(owner).toBeDefined();
    if (!owner) return;
    const rule = defaultConfig.rules[RULE];
    expect(rule).toBeDefined();
    if (!rule) return;
    const config: JevLintConfig = { rules: { [RULE]: rule } };
    const evaluator: Evaluator = {
      async evaluate(request: EvaluationRequest): Promise<Record<string, number>> {
        return Object.fromEntries(Object.keys(request.questions).map((id) => [id, 0.83]));
      },
    };

    const result = await analyzeFileWithFailures({
      filePath: "test/user.test.ts",
      source: owner.source,
      changedLines: [{ start: 1, end: owner.source.split("\n").length }],
      config,
      projectFiles: files,
    }, evaluator);

    expect(result.failures).toEqual([]);
    expect(result.judgments.map((judgment) => judgment.probability)).toEqual([0.83, 0.83, 0.83]);
    expect(result.judgments.map((judgment) => judgment.ruleId)).toEqual([RULE, RULE, RULE]);
    // SAFETY: rule evidence is a JSON object and this builder always sets the title facts.
    const evidence = result.judgments[0]?.evidence as { test?: { title?: string }; fileStem?: string } | null;
    expect(evidence?.test?.title).toBe("getUser");
    expect(evidence?.fileStem).toBe("user");
    expect(result.abstentions).toEqual([]);
  });
});
