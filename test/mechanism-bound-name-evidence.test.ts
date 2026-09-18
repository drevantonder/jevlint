import { readFile } from "node:fs/promises";
import { describe, expect, it } from "vitest";
import { analyzeFileWithFailures } from "../src/analyze.js";
import { extractCandidates } from "../src/candidates.js";
import { defaultConfig } from "../src/config.js";
import { buildRuleEvidence } from "../src/evidence/index.js";
import { buildMechanismBoundNameEvidence } from "../src/evidence/mechanism-bound-name.js";
import type {
  Candidate,
  EvaluationRequest,
  Evaluator,
  JevLintConfig,
  ProjectFile,
} from "../src/types.js";

const RULE = "jev/no-mechanism-bound-name";
const repositories = new URL("./fixtures/repositories/", import.meta.url);

async function project(name: string, paths: string[]): Promise<ProjectFile[]> {
  return Promise.all(paths.map(async (filePath) => ({
    filePath,
    source: await readFile(new URL(`${name}/${filePath}`, repositories), "utf8"),
  })));
}

function functionCandidate(files: ProjectFile[], excerpt: string): Candidate {
  const candidates = files.flatMap((file) => extractCandidates(file.filePath, file.source));
  const candidate = candidates.find(({ kind, source }) =>
    kind === "function" && source.includes(excerpt)
  );
  expect(candidate).toBeDefined();
  if (!candidate) throw new Error(`Fixture has no function containing ${excerpt}.`);
  return candidate;
}

function inlineCandidate(source: string, excerpt: string) {
  const files: ProjectFile[] = [{ filePath: "src/session.ts", source }];
  const candidate = extractCandidates("src/session.ts", source)
    .filter(({ kind }) => kind === "function")
    .find(({ source: text }) => text.includes(excerpt));
  expect(candidate).toBeDefined();
  if (!candidate) throw new Error("Inline source has no matching function.");
  return { candidate, files };
}

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

describe("mechanism bound name evidence", () => {
  it("keeps its proposition untouched while gaining a builder", () => {
    expect(defaultConfig.rules[RULE]).toMatchObject({
      scope: "function",
      question: expect.objectContaining({
        instructions: expect.objectContaining({
          question: "Does this function or variable name describe the mechanism or algorithm (how it works) rather than the caller's goal, so the name lies after any reimplementation?",
        }),
      }),
      message: "This name describes the mechanism rather than the caller's goal.",
    });
    expect(defaultConfig.rules[RULE]).not.toHaveProperty("threshold");
    expect(defaultConfig.rules[RULE]).not.toHaveProperty("severity");
  });

  it("flags a connector-shaped name with body operations and siblings", async () => {
    const files = await project("mechanism-bound-name-mixed", ["src/users.ts"]);

    const result = buildRuleEvidence(RULE, functionCandidate(files, "findUserByLoop"), files);

    expect(result).toEqual({ handled: true, evidence: expect.any(Object) });
    if (!result.handled) return;
    expect(result.evidence).toMatchObject({
      function: { name: "findUserByLoop", exported: true },
      mechanismNames: [
        expect.objectContaining({
          name: "findUserByLoop",
          kind: "function",
          mechanismTokens: ["loop"],
          connector: "by",
        }),
      ],
      operations: expect.any(Array),
      siblings: expect.arrayContaining([
        expect.objectContaining({ name: "findUser" }),
        expect.objectContaining({ name: "parseWithRegex" }),
      ]),
      callers: [],
    });
  });

  it("flags a bare mechanism token without a connector", async () => {
    const files = await project("mechanism-bound-name-mixed", ["src/users.ts"]);

    expect(buildMechanismBoundNameEvidence(functionCandidate(files, "hashPassword"), files))
      .toMatchObject({
        function: { name: "hashPassword" },
        mechanismNames: expect.arrayContaining([
          expect.objectContaining({
            name: "hashPassword",
            kind: "function",
            mechanismTokens: ["hash"],
            connector: null,
          }),
        ]),
      });
  });

  it("flags a mechanism-bound local inside a goal-named function", () => {
    const source = "export function activeSession(token: string): string {\n"
      + "  const hashBucket = \"session:\" + token;\n"
      + "  return hashBucket;\n"
      + "}\n";
    const { candidate, files } = inlineCandidate(source, "activeSession");

    expect(buildMechanismBoundNameEvidence(candidate, files)).toMatchObject({
      function: { name: "activeSession" },
      mechanismNames: [
        expect.objectContaining({
          name: "hashBucket",
          kind: "local",
          mechanismTokens: ["hash"],
        }),
      ],
    });
  });

  it("abstains when the name states the goal with no mechanism token", async () => {
    const files = await project("mechanism-bound-name-mixed", ["src/users.ts"]);

    expect(buildMechanismBoundNameEvidence(functionCandidate(files, "function findUser("), files))
      .toBeUndefined();
  });

  it("abstains for anonymous functions", () => {
    const source = "export default function (values: string[]): string[] {\n"
      + "  return values.map((value) => value.trim());\n"
      + "}\n";
    const { candidate, files } = inlineCandidate(source, "values.map");

    expect(buildMechanismBoundNameEvidence(candidate, files)).toBeUndefined();
  });

  it("abstains for non-function candidates", async () => {
    const files = await project("confusion-confessing-positive", ["src/settle.ts"]);
    const owner = files[0];
    expect(owner).toBeDefined();
    if (!owner) return;
    const candidate = extractCandidates(owner.filePath, owner.source)
      .find(({ kind }) => kind === "comment");
    expect(candidate).toBeDefined();
    if (!candidate) return;

    expect(buildMechanismBoundNameEvidence(candidate, files)).toBeUndefined();
  });

  it("sends mechanism-bound names to evaluation with evidence and keeps raw scores", async () => {
    const rule = defaultConfig.rules[RULE];
    expect(rule).toBeDefined();
    if (!rule) return;
    const config: JevLintConfig = { rules: { [RULE]: rule } };

    const smellySource = `export function findUserByLoop(users: { id: string }[], id: string): { id: string } | undefined {
  for (let index = 0; index < users.length; index += 1) {
    if (users[index]?.id === id) return users[index];
  }
  return undefined;
}
`;
    const smellyFiles: ProjectFile[] = [{ filePath: "src/users.ts", source: smellySource }];

    const hot = new FakeEvaluator([0.82]);
    const hotResult = await analyzeFileWithFailures({
      filePath: "src/users.ts",
      source: smellySource,
      changedLines: [{ start: 1, end: 6 }],
      config,
      projectFiles: smellyFiles,
    }, hot);
    expect(hotResult.judgments.map(({ ruleId }) => ruleId)).toEqual([RULE]);
    expect(hotResult.judgments[0]?.probability).toBe(0.82);
    expect(hotResult.abstentions).toEqual([]);
    const hotEvidence = hot.requests[0]?.state.candidates[0]?.evidence?.[RULE];
    expect(hotEvidence).toMatchObject({
      function: { name: "findUserByLoop" },
      mechanismNames: [
        expect.objectContaining({ mechanismTokens: ["loop"], connector: "by" }),
      ],
    });

    const cold = new FakeEvaluator([0.12]);
    const coldResult = await analyzeFileWithFailures({
      filePath: "src/users.ts",
      source: smellySource,
      changedLines: [{ start: 1, end: 6 }],
      config,
      projectFiles: smellyFiles,
    }, cold);
    expect(coldResult.judgments.map(({ ruleId }) => ruleId)).toEqual([RULE]);
    expect(coldResult.judgments[0]?.probability).toBe(0.12);

    const honestSource = `export function findUser(users: { id: string }[], id: string): { id: string } | undefined {
  return users.length > 0 ? users[0] : undefined;
}
`;
    const honest = await analyzeFileWithFailures({
      filePath: "src/users.ts",
      source: honestSource,
      changedLines: [{ start: 1, end: 3 }],
      config,
      projectFiles: [{ filePath: "src/users.ts", source: honestSource }],
    }, new FakeEvaluator([0.9]));
    expect(honest.judgments).toEqual([]);
    expect(honest.abstentions).toEqual([
      { ruleId: RULE, candidateKind: "function", count: 1 },
    ]);
  });
});
