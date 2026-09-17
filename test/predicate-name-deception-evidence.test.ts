import { readFile } from "node:fs/promises";
import { describe, expect, it } from "vitest";
import { analyzeFileWithFailures } from "../src/analyze.js";
import { extractCandidates } from "../src/candidates.js";
import { defaultConfig } from "../src/config.js";
import { buildRuleEvidence } from "../src/evidence/index.js";
import { buildPredicateNameDeceptionEvidence } from "../src/evidence/predicate-name-deception.js";
import type {
  Candidate,
  EvaluationRequest,
  Evaluator,
  JevLintConfig,
  ProjectFile,
} from "../src/types.js";

const RULE = "jev/no-predicate-name-deception";
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

class StubEvaluator implements Evaluator {
  async evaluate(request: EvaluationRequest): Promise<Record<string, number>> {
    return Object.fromEntries(Object.keys(request.questions).map((id) => [id, 0.5]));
  }
}

describe("predicate name deception wiring", () => {
  it("ships as a function judgment without thresholds", () => {
    expect(defaultConfig.rules[RULE]).toMatchObject({
      scope: "function",
      message: expect.any(String),
    });
    expect(defaultConfig.rules[RULE]).not.toHaveProperty("threshold");
    expect(defaultConfig.rules[RULE]).not.toHaveProperty("severity");
  });

  it("flags a predicate name returning a non-boolean", async () => {
    const files = await project("predicate-name-deception-mixed", ["src/access.ts"]);

    const result = buildRuleEvidence(RULE, functionCandidate(files, "isEligible"), files);

    expect(result).toEqual({ handled: true, evidence: expect.any(Object) });
    if (!result.handled) return;
    expect(result.evidence).toMatchObject({
      function: { name: "isEligible", prefix: "is" },
      returnType: "string | null",
      returns: expect.arrayContaining([
        expect.objectContaining({ booleanValued: false }),
      ]),
    });
  });

  it.each([
    ["boolean predicate", "isReady"],
    ["non-predicate name with object returns", "fetchStatus"],
    ["type predicate", "isUser"],
  ])("abstains for %s", async (_label, excerpt) => {
    const files = await project("predicate-name-deception-mixed", ["src/access.ts"]);

    expect(buildPredicateNameDeceptionEvidence(functionCandidate(files, excerpt), files))
      .toBeUndefined();
  });

  it("abstains for comment candidates", async () => {
    const files = await project("confusion-confessing-positive", ["src/settle.ts"]);
    const owner = files[0];
    expect(owner).toBeDefined();
    if (!owner) return;
    const candidate = extractCandidates(owner.filePath, owner.source)
      .find(({ kind }) => kind === "comment");
    expect(candidate).toBeDefined();
    if (!candidate) return;

    expect(buildPredicateNameDeceptionEvidence(candidate, files)).toBeUndefined();
  });

  it("sends deceptive predicates to evaluation and abstains honest ones", async () => {
    const rule = defaultConfig.rules[RULE];
    expect(rule).toBeDefined();
    if (!rule) return;
    const config: JevLintConfig = { rules: { [RULE]: rule } };
    const evaluator = new StubEvaluator();

    const deceptiveSource = `export function hasAccess(user: { role: string }): string | null {
  if (user.role === "admin") return "full";
  return null;
}
`;
    const deceptive = await analyzeFileWithFailures({
      filePath: "src/access.ts",
      source: deceptiveSource,
      changedLines: [{ start: 1, end: 4 }],
      config,
      projectFiles: [{ filePath: "src/access.ts", source: deceptiveSource }],
    }, evaluator);
    expect(deceptive.judgments.map(({ ruleId }) => ruleId)).toEqual([RULE]);
    expect(deceptive.abstentions).toEqual([]);

    const honestSource = `export function hasAccess(user: { role: string }): boolean {
  return user.role === "admin";
}
`;
    const honest = await analyzeFileWithFailures({
      filePath: "src/access.ts",
      source: honestSource,
      changedLines: [{ start: 1, end: 3 }],
      config,
      projectFiles: [{ filePath: "src/access.ts", source: honestSource }],
    }, evaluator);
    expect(honest.judgments).toEqual([]);
    expect(honest.abstentions).toEqual([
      { ruleId: RULE, candidateKind: "function", count: 1 },
    ]);
  });
});
