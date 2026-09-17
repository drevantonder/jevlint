import { readFile } from "node:fs/promises";
import { describe, expect, it } from "vitest";
import { analyzeFileWithFailures } from "../src/analyze.js";
import { extractCandidates } from "../src/candidates.js";
import { defaultConfig } from "../src/config.js";
import { buildRuleEvidence } from "../src/evidence/index.js";
import { buildConfusionConfessingCommentEvidence } from "../src/evidence/confusion-confessing-comment.js";
import type {
  Candidate,
  EvaluationRequest,
  Evaluator,
  JevLintConfig,
  ProjectFile,
} from "../src/types.js";

const RULE = "jev/no-confusion-confessing-comment";
const repositories = new URL("./fixtures/repositories/", import.meta.url);

async function project(name: string, paths: string[]): Promise<ProjectFile[]> {
  return Promise.all(paths.map(async (filePath) => ({
    filePath,
    source: await readFile(new URL(`${name}/${filePath}`, repositories), "utf8"),
  })));
}

function commentCandidate(files: ProjectFile[], excerpt: string): Candidate {
  const owner = files[0];
  expect(owner).toBeDefined();
  if (!owner) throw new Error("Fixture has no changed file.");
  const candidate = extractCandidates(owner.filePath, owner.source)
    .find(({ kind, source }) => kind === "comment" && source.includes(excerpt));
  expect(candidate).toBeDefined();
  if (!candidate) throw new Error(`Fixture has no comment containing ${excerpt}.`);
  return candidate;
}

class StubEvaluator implements Evaluator {
  async evaluate(request: EvaluationRequest): Promise<Record<string, number>> {
    return Object.fromEntries(Object.keys(request.questions).map((id) => [id, 0.5]));
  }
}

describe("confusion confessing comment wiring", () => {
  it("ships as a comment judgment without thresholds", () => {
    expect(defaultConfig.rules[RULE]).toMatchObject({
      scope: "comment",
      message: expect.any(String),
    });
    expect(defaultConfig.rules[RULE]).not.toHaveProperty("threshold");
    expect(defaultConfig.rules[RULE]).not.toHaveProperty("severity");
  });

  it("passes confessions through with adjoining behavior and empty pointers", async () => {
    const files = await project("confusion-confessing-positive", ["src/settle.ts"]);

    const result = buildRuleEvidence(RULE, commentCandidate(files, "Not sure why"), files);

    expect(result).toEqual({ handled: true, evidence: expect.any(Object) });
    if (!result.handled) return;
    expect(result.evidence).toMatchObject({
      confessionSignals: [{ signal: "not-sure-why" }],
      adjoiningFunction: { name: "settle" },
      testPinning: [],
      trackedWork: [],
    });
  });

  it("abstains when the confession names a concrete verification", async () => {
    const files = await project("confusion-confessing-verified", ["src/settle.ts"]);

    expect(buildConfusionConfessingCommentEvidence(
      commentCandidate(files, "Magic retry ladder"),
      files,
    )).toBeUndefined();
  });

  it("abstains for plain explanatory comments", () => {
    const source = `// Settle the order once all line items arrive.
export function settle(order: string): string {
  return order;
}
`;
    const candidate = extractCandidates("src/settle.ts", source)
      .find(({ kind }) => kind === "comment");
    expect(candidate).toBeDefined();
    if (!candidate) return;

    expect(buildConfusionConfessingCommentEvidence(
      candidate,
      [{ filePath: "src/settle.ts", source }],
    )).toBeUndefined();
  });

  it("abstains for function candidates", async () => {
    const files = await project("confusion-confessing-positive", ["src/settle.ts"]);
    const owner = files[0];
    expect(owner).toBeDefined();
    if (!owner) return;
    const candidate = extractCandidates(owner.filePath, owner.source)
      .find(({ kind }) => kind === "function");
    expect(candidate).toBeDefined();
    if (!candidate) return;

    expect(buildConfusionConfessingCommentEvidence(candidate, files)).toBeUndefined();
  });

  it("sends confessions to evaluation and abstains verified notes", async () => {
    const rule = defaultConfig.rules[RULE];
    expect(rule).toBeDefined();
    if (!rule) return;
    const config: JevLintConfig = { rules: { [RULE]: rule } };
    const evaluator = new StubEvaluator();

    const confessingSource = `// No idea why, but removing this breaks prod.
export function settle(order: string): string {
  return order;
}
`;
    const confessing = await analyzeFileWithFailures({
      filePath: "src/settle.ts",
      source: confessingSource,
      changedLines: [{ start: 1, end: 4 }],
      config,
      projectFiles: [{ filePath: "src/settle.ts", source: confessingSource }],
    }, evaluator);
    expect(confessing.judgments.map(({ ruleId }) => ruleId)).toEqual([RULE]);
    expect(confessing.abstentions).toEqual([]);

    const verifiedSource = `// No idea why, but removing this breaks prod. See #482.
export function settle(order: string): string {
  return order;
}
`;
    const verified = await analyzeFileWithFailures({
      filePath: "src/settle.ts",
      source: verifiedSource,
      changedLines: [{ start: 1, end: 4 }],
      config,
      projectFiles: [{ filePath: "src/settle.ts", source: verifiedSource }],
    }, evaluator);
    expect(verified.judgments).toEqual([]);
    expect(verified.abstentions).toEqual([
      { ruleId: RULE, candidateKind: "comment", count: 1 },
    ]);
  });
});
