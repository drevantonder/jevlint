import { readFile } from "node:fs/promises";
import { describe, expect, it } from "vitest";
import { analyzeFileWithFailures } from "../src/analyze.js";
import { extractCandidates } from "../src/candidates.js";
import { defaultConfig } from "../src/config.js";
import { findFunctionCallersWithCoverage } from "../src/evidence/repository.js";
import { buildSingleCallerExportedHelperEvidence } from "../src/evidence/single-caller-exported-helper.js";
import { findTransitiveTestPins, partitionCallersByTest } from "../src/evidence/test-scope.js";
import type {
  Candidate,
  EvaluationRequest,
  Evaluator,
  JevLintConfig,
  ProjectFile,
} from "../src/types.js";

// Non-src/ layout: root-level helper plus app, a root test file with no
// .test. segment (vitest import), a lib/ colocated test (filename segment),
// and a packages/a/src contract test with no .test. segment (node:test
// import) exercising the app seam. No src/ directory anywhere.
const root = new URL("./fixtures/repositories/nonsrc-caller-scope/", import.meta.url);

const LAYOUT = [
  "helper.ts",
  "app.ts",
  "helper.verify.ts",
  "lib/pricing.test.ts",
  "packages/a/src/order.checks.ts",
];

async function load(): Promise<ProjectFile[]> {
  return Promise.all(LAYOUT.map(async (filePath): Promise<ProjectFile> => ({
    filePath,
    source: await readFile(new URL(filePath, root), "utf8"),
  })));
}

function candidateFor(projectFiles: ProjectFile[]): Candidate {
  const owner = projectFiles.find((file) => file.filePath === "helper.ts");
  expect(owner).toBeDefined();
  if (!owner) throw new Error("fixture helper missing");
  const candidate = extractCandidates(owner.filePath, owner.source)[0];
  expect(candidate).toBeDefined();
  if (!candidate) throw new Error("candidate missing");
  return candidate;
}

function callerPaths(callers: { filePath: string }[]): string[] {
  return callers.map(({ filePath }) => filePath).sort();
}

describe("non-src/ caller scope", () => {
  it("partitions production from test callers by content, not directory", async () => {
    const projectFiles = await load();
    const coverage = findFunctionCallersWithCoverage("helper.ts", "formatCents", projectFiles);
    expect(callerPaths(coverage.callers)).toEqual([
      "app.ts",
      "helper.verify.ts",
      "lib/pricing.test.ts",
    ]);

    const { production, test } = partitionCallersByTest(coverage.callers, projectFiles);
    expect(callerPaths(production)).toEqual(["app.ts"]);
    // helper.verify.ts has no .test. segment: only the vitest import plus
    // it/expect usage mark it. order.checks.ts names the seam, not the
    // helper, so it pins transitively instead of calling directly.
    expect(callerPaths(test)).toEqual(["helper.verify.ts", "lib/pricing.test.ts"]);
  });

  it("names the content-marked test callers and the transitive pin", async () => {
    const projectFiles = await load();
    const evidence = buildSingleCallerExportedHelperEvidence(candidateFor(projectFiles), projectFiles);

    expect(evidence).toMatchObject({
      function: { name: "formatCents", exported: true },
      totalCallers: 1,
      caller: expect.objectContaining({ filePath: "app.ts" }),
      callerOwnership: "importing-module",
      testCallerCount: 2,
      testCallers: [
        expect.objectContaining({ filePath: "helper.verify.ts" }),
        expect.objectContaining({ filePath: "lib/pricing.test.ts" }),
      ],
      testContracts: {
        directCount: 2,
        transitiveCount: 1,
        transitive: [expect.objectContaining({
          test: "packages/a/src/order.checks.ts",
          seam: "label",
          seamFile: "app.ts",
          candidate: "formatCents",
        })],
      },
    });
  });

  it("finds the packages/a/src pin without a filename segment", async () => {
    const projectFiles = await load();

    expect(findTransitiveTestPins("helper.ts", "formatCents", projectFiles)).toEqual([
      expect.objectContaining({
        test: "packages/a/src/order.checks.ts",
        seam: "label",
        seamFile: "app.ts",
        candidate: "formatCents",
      }),
    ]);
  });

  it("carries the named test callers through a fake evaluator", async () => {
    const projectFiles = await load();
    const owner = projectFiles.find((file) => file.filePath === "helper.ts");
    expect(owner).toBeDefined();
    if (!owner) return;
    const rule = defaultConfig.rules["jev/no-single-caller-exported-helper"];
    expect(rule).toBeDefined();
    if (!rule) return;
    const config: JevLintConfig = { rules: { "jev/no-single-caller-exported-helper": rule } };
    const evaluator: Evaluator = {
      async evaluate(request: EvaluationRequest): Promise<Record<string, number>> {
        return Object.fromEntries(Object.keys(request.questions).map((id) => [id, 0.42]));
      },
    };

    const result = await analyzeFileWithFailures({
      filePath: "helper.ts",
      source: owner.source,
      changedLines: [{ start: 1, end: owner.source.split("\n").length }],
      config,
      projectFiles,
    }, evaluator);

    expect(result.failures).toEqual([]);
    expect(result.judgments.map((judgment) => judgment.probability)).toEqual([0.42]);
    // SAFETY: rule evidence is a JSON object and this builder sets the
    // caller partition facts on every firing.
    const evidence = result.judgments[0]?.evidence as {
      testCallerCount?: number;
      testCallers?: { filePath: string }[];
      testContracts?: { directCount?: number; transitiveCount?: number };
    } | null;
    expect(evidence?.testCallerCount).toBe(2);
    expect(callerPaths(evidence?.testCallers ?? [])).toEqual([
      "helper.verify.ts",
      "lib/pricing.test.ts",
    ]);
    expect(evidence?.testContracts).toMatchObject({ directCount: 2, transitiveCount: 1 });
  });
});
