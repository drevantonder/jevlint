import { readFile } from "node:fs/promises";
import { describe, expect, it } from "vitest";
import { analyzeFileWithFailures } from "../src/analyze.js";
import { extractCandidates } from "../src/candidates.js";
import { defaultConfig } from "../src/config.js";
import { buildRuleEvidence } from "../src/evidence/index.js";
import { buildMysteriousNameEvidence } from "../src/evidence/mysterious-name.js";
import type {
  Candidate,
  EvaluationRequest,
  Evaluator,
  JevLintConfig,
  ProjectFile,
} from "../src/types.js";

const RULE = "jev/no-mysterious-name";
const repositories = new URL("./fixtures/repositories/", import.meta.url);

async function project(name: string, paths: string[]): Promise<ProjectFile[]> {
  return Promise.all(paths.map(async (filePath) => ({
    filePath,
    source: await readFile(new URL(`${name}/${filePath}`, repositories), "utf8"),
  })));
}

function functionCandidate(files: ProjectFile[], name: string): Candidate {
  const candidates = files.flatMap((file) =>
    extractCandidates(file.filePath, file.source)
      .map((candidate) => ({ candidate, file }))
  );
  const hit = candidates.find(({ candidate }) =>
    candidate.kind === "function" && candidate.source.includes(name)
  );
  expect(hit).toBeDefined();
  if (!hit) throw new Error(`Fixture has no function containing ${name}.`);
  return hit.candidate;
}

class StubEvaluator implements Evaluator {
  async evaluate(request: EvaluationRequest): Promise<Record<string, number>> {
    return Object.fromEntries(Object.keys(request.questions).map((id) => [id, 0.5]));
  }
}

describe("mysterious name evidence", () => {
  it("keeps its proposition untouched while gaining a builder", () => {
    expect(defaultConfig.rules[RULE]).toMatchObject({
      scope: "function",
      question: expect.objectContaining({
        instructions: expect.objectContaining({
          question: "Do the function name or its important local names fail to communicate their purpose?",
        }),
      }),
      message: "Names obscure this function's purpose.",
    });
  });

  it("extracts the name inventory with use counts and scope lines", async () => {
    const files = await project("mysterious-name-smelly", [
      "src/process.ts",
      "src/policies.ts",
    ]);

    const result = buildRuleEvidence(RULE, functionCandidate(files, "function process"), files);

    expect(result).toEqual({ handled: true, evidence: expect.any(Object) });
    if (!result.handled) return;
    expect(result.evidence).toMatchObject({
      function: { name: "process", exported: true },
      names: expect.arrayContaining([
        expect.objectContaining({ name: "data", kind: "param" }),
        expect.objectContaining({ name: "x", kind: "local" }),
        expect.objectContaining({ name: "tmp", kind: "local" }),
        expect.objectContaining({ name: "result", kind: "local" }),
      ]),
      imports: ["normalizeRetry"],
      callers: [],
    });
    // SAFETY: The dispatch contract returns this builder's inventory object for this rule.
    const names = (result.evidence as { names: { name: string; uses: number }[] }).names;
    expect(names.find(({ name }) => name === "x")?.uses).toBeGreaterThan(0);
  });

  it("abstains for anonymous functions", async () => {
    const files = await project("mysterious-name-smelly", ["src/anonymous.ts"]);

    expect(buildMysteriousNameEvidence(functionCandidate(files, "values.map"), files))
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

    expect(buildMysteriousNameEvidence(candidate, files)).toBeUndefined();
  });

  it("sends named functions to evaluation and abstains anonymous ones", async () => {
    const rule = defaultConfig.rules[RULE];
    expect(rule).toBeDefined();
    if (!rule) return;
    const config: JevLintConfig = { rules: { [RULE]: rule } };
    const evaluator = new StubEvaluator();

    const namedSource = `export function process(data: string[]): string[] {
  return data.map((item) => item.trim());
}
`;
    const named = await analyzeFileWithFailures({
      filePath: "src/process.ts",
      source: namedSource,
      changedLines: [{ start: 1, end: 3 }],
      config,
      projectFiles: [{ filePath: "src/process.ts", source: namedSource }],
    }, evaluator);
    expect(named.judgments.map(({ ruleId }) => ruleId)).toEqual([RULE]);
    expect(named.abstentions).toEqual([
      { ruleId: RULE, candidateKind: "function", count: 1 },
    ]);

    const anonymousSource = `export default function (values: string[]): string[] {
  return values.map((value) => value.trim());
}
`;
    const anonymous = await analyzeFileWithFailures({
      filePath: "src/anonymous.ts",
      source: anonymousSource,
      changedLines: [{ start: 1, end: 3 }],
      config,
      projectFiles: [{ filePath: "src/anonymous.ts", source: anonymousSource }],
    }, evaluator);
    expect(anonymous.judgments).toEqual([]);
    expect(anonymous.abstentions).toEqual([
      { ruleId: RULE, candidateKind: "function", count: 2 },
    ]);
  });
});
