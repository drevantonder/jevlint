import { readFile } from "node:fs/promises";
import { describe, expect, it } from "vitest";
import { analyzeFileWithFailures } from "../src/analyze.js";
import { extractCandidates } from "../src/candidates.js";
import { defaultConfig } from "../src/defaults.js";
import { buildUnusedExportedHelperEvidence } from "../src/evidence/unused-exported-helper.js";
import type { EvaluationRequest, Evaluator, JevLintConfig, ProjectFile } from "../src/types.js";

const repositories = new URL("./fixtures/repositories/", import.meta.url);

async function project(name: string, paths: string[]): Promise<ProjectFile[]> {
  return Promise.all(paths.map(async (filePath) => ({
    filePath,
    source: await readFile(new URL(`${name}/${filePath}`, repositories), "utf8"),
  })));
}

function functionCandidate(source: string, filePath: string, snippet: string) {
  const candidate = extractCandidates(filePath, source)
    .find(({ kind, source: text }) => kind === "function" && text.includes(snippet));
  expect(candidate).toBeDefined();
  if (!candidate) throw new Error("missing candidate");
  return candidate;
}

describe("unused exported helper evidence", () => {
  it("reports a zero-caller export with no importers and no re-export", async () => {
    const projectFiles = await project("unused-export-dead", [
      "src/totals.ts",
      "src/app.ts",
    ]);
    const owner = projectFiles[0];
    expect(owner).toBeDefined();
    if (!owner) return;

    const evidence = buildUnusedExportedHelperEvidence(
      functionCandidate(owner.source, owner.filePath, "orphanTotal"),
      projectFiles,
    );

    expect(evidence).toMatchObject({
      function: { name: "orphanTotal", exported: true, filePath: "src/totals.ts" },
      callerCount: 0,
      callerExcerpts: [],
      testCallers: [],
      testCallerCount: 0,
      symbolImporters: [],
      reexport: { reexported: false, reexportPaths: [] },
      textualLeads: [],
    });
  });

  it("surfaces the barrel re-export path as a liveness signal", async () => {
    const projectFiles = await project("unused-export-barrel", [
      "src/totals.ts",
      "src/index.ts",
    ]);
    const owner = projectFiles[0];
    expect(owner).toBeDefined();
    if (!owner) return;

    const evidence = buildUnusedExportedHelperEvidence(
      functionCandidate(owner.source, owner.filePath, "orphanTotal"),
      projectFiles,
    );

    expect(evidence).toMatchObject({
      callerCount: 0,
      reexport: { reexported: true, reexportPaths: ["src/index.ts"] },
    });
  });

  it("abstains when the export has a live production caller", async () => {
    const projectFiles = await project("unused-export-dead", [
      "src/totals.ts",
      "src/app.ts",
    ]);
    const owner = projectFiles[0];
    expect(owner).toBeDefined();
    if (!owner) return;

    expect(buildUnusedExportedHelperEvidence(
      functionCandidate(owner.source, owner.filePath, "liveTotal"),
      projectFiles,
    )).toBeUndefined();
  });

  it("fires with named test callers when only tests call the export", async () => {
    const projectFiles = await project("unused-export-test-only", [
      "src/plan.ts",
      "src/checkout.ts",
      "test/questions.test.ts",
    ]);
    const owner = projectFiles[0];
    expect(owner).toBeDefined();
    if (!owner) return;

    const evidence = buildUnusedExportedHelperEvidence(
      functionCandidate(owner.source, owner.filePath, "planBatches"),
      projectFiles,
    );

    expect(evidence).toMatchObject({
      function: { name: "planBatches", exported: true, filePath: "src/plan.ts" },
      callerCount: 0,
      callerExcerpts: [],
      testCallerCount: 1,
      testCallers: [expect.objectContaining({
        filePath: "test/questions.test.ts",
        call: 'planBatches(["a"])',
      })],
    });
  });

  it("abstains for the production-called export beside the test-only one", async () => {
    const projectFiles = await project("unused-export-test-only", [
      "src/plan.ts",
      "src/checkout.ts",
      "test/questions.test.ts",
    ]);
    const owner = projectFiles[0];
    expect(owner).toBeDefined();
    if (!owner) return;

    expect(buildUnusedExportedHelperEvidence(
      functionCandidate(owner.source, owner.filePath, "shipBatches"),
      projectFiles,
    )).toBeUndefined();
  });

  it("abstains for an unexported zero-caller function", () => {
    const source = "function orphan(items: number[]) { return items.length; }\n"
      + "export function live(items: number[]) { return items.length; }\n";
    const candidate = functionCandidate(source, "src/totals.ts", "function orphan");

    expect(buildUnusedExportedHelperEvidence(candidate, [{ filePath: "src/totals.ts", source }]))
      .toBeUndefined();
  });

  it("abstains for a marked implementation owned by the superseded rule", () => {
    const source = "/** @deprecated use liveTotal instead */\n"
      + "export function orphanTotal(items: number[]): number {\n"
      + "  return items.length;\n"
      + "}\n";
    const candidate = functionCandidate(source, "src/totals.ts", "orphanTotal");

    expect(buildUnusedExportedHelperEvidence(candidate, [{ filePath: "src/totals.ts", source }]))
      .toBeUndefined();
  });

  it("fires the test-only export through a fake evaluator with raw scores", async () => {
    const projectFiles = await project("unused-export-test-only", [
      "src/plan.ts",
      "src/checkout.ts",
      "test/questions.test.ts",
    ]);
    const owner = projectFiles.find((file) => file.filePath === "src/plan.ts");
    expect(owner).toBeDefined();
    if (!owner) return;
    const rule = defaultConfig.rules["jev/no-unused-exported-helper"];
    expect(rule).toBeDefined();
    if (!rule) return;
    const config: JevLintConfig = { rules: { "jev/no-unused-exported-helper": rule } };
    const evaluator: Evaluator = {
      async evaluate(request: EvaluationRequest): Promise<Record<string, number>> {
        return Object.fromEntries(Object.keys(request.questions).map((id) => [id, 0.83]));
      },
    };

    const result = await analyzeFileWithFailures({
      filePath: "src/plan.ts",
      source: owner.source,
      changedLines: [{ start: 1, end: owner.source.split("\n").length }],
      config,
      projectFiles,
    }, evaluator);

    expect(result.failures).toEqual([]);
    expect(result.judgments.map((judgment) => judgment.probability)).toEqual([0.83]);
    const batched = result.judgments.find((judgment) =>
      judgment.span.start.line === 1,
    );
    expect(batched?.ruleId).toBe("jev/no-unused-exported-helper");
    // SAFETY: rule evidence is a JSON object and this builder always sets the test-caller fields.
    const evidence = batched?.evidence as { testCallers?: { filePath: string }[]; testCallerCount?: number } | null;
    expect(evidence?.testCallerCount).toBe(1);
    expect(evidence?.testCallers?.map((caller) => caller.filePath))
      .toEqual(["test/questions.test.ts"]);
    expect(result.abstentions).toContainEqual({
      ruleId: "jev/no-unused-exported-helper",
      candidateKind: "function",
      count: 1,
    });
  });
});
