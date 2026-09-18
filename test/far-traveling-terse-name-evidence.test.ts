import { readFile } from "node:fs/promises";
import { describe, expect, it } from "vitest";
import { analyzeFileWithFailures } from "../src/analyze.js";
import { extractCandidates } from "../src/candidates.js";
import { defaultConfig } from "../src/config.js";
import { buildFarTravelingTerseNameEvidence } from "../src/evidence/far-traveling-terse-name.js";
import type {
  Candidate,
  EvaluationRequest,
  Evaluator,
  JevLintConfig,
  ProjectFile,
} from "../src/types.js";

const RULE = "jev/no-far-traveling-terse-name";
const repositories = new URL("./fixtures/repositories/", import.meta.url);

async function project(name: string, paths: string[]): Promise<ProjectFile[]> {
  return Promise.all(paths.map(async (filePath) => ({
    filePath,
    source: await readFile(new URL(`${name}/${filePath}`, repositories), "utf8"),
  })));
}

function functionCandidate(files: ProjectFile[], snippet: string): Candidate {
  const hits = files.flatMap((file) =>
    extractCandidates(file.filePath, file.source)
      .filter(({ kind }) => kind === "function")
      .map((candidate) => candidate)
  );
  const hit = hits.find(({ source }) => source.includes(snippet));
  expect(hit).toBeDefined();
  if (!hit) throw new Error(`Fixture has no function containing ${snippet}.`);
  return hit;
}

describe("far traveling terse name evidence", () => {
  it("registers its proposition without ranking language", () => {
    expect(defaultConfig.rules[RULE]).toMatchObject({
      scope: "function",
      question: expect.objectContaining({
        instructions: expect.objectContaining({
          question: "Does a terse name in this function survive beyond the few-line scope its brevity is justified by?",
        }),
      }),
      message: "This terse name travels farther than its brevity justifies.",
    });
  });

  it("flags a terse param read far from its declaration and captured in a closure", async () => {
    const files = await project("far-traveling-terse-name-smelly", [
      "src/pipeline.ts",
      "src/loops.ts",
    ]);

    const evidence = buildFarTravelingTerseNameEvidence(
      functionCandidate(files, "summarizeOrders"),
      files,
    );

    expect(evidence).toMatchObject({
      function: { name: "summarizeOrders", exported: true },
      bindings: expect.arrayContaining([
        expect.objectContaining({
          name: "d",
          kind: "param",
          exposedByExport: true,
          capturedAcrossClosure: true,
        }),
      ]),
    });
    const binding = evidence?.bindings.find(({ name }) => name === "d");
    expect(binding?.spanLines).toBeGreaterThan(1);
    expect(binding?.uses).toBeGreaterThan(1);
    expect(binding?.lastUseLine).toBeGreaterThan(binding?.declarationLine ?? 0);
  });

  it("abstains when every name is descriptive", () => {
    const source = "export function calculateTotal(items: number[]): number {\n"
      + "  const aggregate = items.reduce((sum, item) => sum + item, 0);\n"
      + "  return aggregate;\n"
      + "}\n";
    const projectFiles: ProjectFile[] = [{ filePath: "src/billing.ts", source }];
    const candidate = extractCandidates("src/billing.ts", source)
      .filter(({ kind }) => kind === "function")
      .find(({ source: text }) => text.includes("calculateTotal"));
    expect(candidate).toBeDefined();
    if (!candidate) return;

    expect(buildFarTravelingTerseNameEvidence(candidate, projectFiles)).toBeUndefined();
  });

  it("abstains for loop counters, short catch bindings, and one-liner callbacks", async () => {
    const files = await project("far-traveling-terse-name-smelly", ["src/loops.ts"]);

    for (const snippet of ["function total", "function first", "function describe"]) {
      expect(buildFarTravelingTerseNameEvidence(functionCandidate(files, snippet), files))
        .toBeUndefined();
    }
  });

  it("carries binding travel facts into the judgment through a fake evaluator", async () => {
    const files = await project("far-traveling-terse-name-smelly", ["src/pipeline.ts"]);
    const owner = files[0];
    expect(owner).toBeDefined();
    if (!owner) return;
    const rule = defaultConfig.rules[RULE];
    expect(rule).toBeDefined();
    if (!rule) return;
    const config: JevLintConfig = { rules: { [RULE]: rule } };
    const evaluator: Evaluator = {
      async evaluate(request: EvaluationRequest): Promise<Record<string, number>> {
        return Object.fromEntries(Object.keys(request.questions).map((id) => [id, 0.79]));
      },
    };

    const result = await analyzeFileWithFailures({
      filePath: owner.filePath,
      source: owner.source,
      changedLines: [{ start: 1, end: owner.source.split("\n").length }],
      config,
      projectFiles: files,
    }, evaluator);

    expect(result.failures).toEqual([]);
    expect(result.judgments.map((judgment) => judgment.probability)).toEqual([0.79]);
    const [judgment] = result.judgments;
    expect(judgment?.ruleId).toBe(RULE);
    // SAFETY: rule evidence is a JSON object and this builder always sets the bindings array on firing.
    const evidence = judgment?.evidence as {
      bindings?: { name?: string; spanLines?: number; capturedAcrossClosure?: boolean }[];
    } | null;
    expect(evidence?.bindings).toEqual(expect.arrayContaining([
      expect.objectContaining({ name: "d", capturedAcrossClosure: true }),
    ]));
    expect(evidence?.bindings?.find(({ name }) => name === "d")?.spanLines)
      .toBeGreaterThan(1);
  });
});
