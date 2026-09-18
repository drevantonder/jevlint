import { readFile } from "node:fs/promises";
import { describe, expect, it } from "vitest";
import { analyzeFileWithFailures } from "../src/analyze.js";
import { extractCandidates } from "../src/candidates.js";
import { defaultConfig } from "../src/defaults.js";
import { buildSingleCallerExportedHelperEvidence } from "../src/evidence/single-caller-exported-helper.js";
import type { EvaluationRequest, Evaluator, JevLintConfig, ProjectFile } from "../src/types.js";

const root = new URL("./fixtures/repositories/single-caller-smelly/", import.meta.url);

async function load(filePath: string): Promise<ProjectFile> {
  return { filePath, source: await readFile(new URL(filePath, root), "utf8") };
}

describe("single caller exported helper evidence", () => {
  it("shows the lone caller, its ownership, and the absence of re-export", async () => {
    const projectFiles = await Promise.all([
      "src/format.ts",
      "src/cart.ts",
    ].map(load));
    const owner = projectFiles[0];
    expect(owner).toBeDefined();
    if (!owner) return;
    const candidate = extractCandidates(owner.filePath, owner.source)[0];
    expect(candidate).toBeDefined();
    if (!candidate) return;

    const evidence = buildSingleCallerExportedHelperEvidence(candidate, projectFiles);

    expect(evidence).toMatchObject({
      function: { name: "formatCents", exported: true },
      totalCallers: 1,
      caller: expect.objectContaining({ filePath: "src/format.ts" }),
      callerOwnership: "same-file",
      reexport: { reexported: false, reexportPaths: [] },
    });
  });

  it("abstains when a second caller demonstrates reuse", async () => {
    const shared = new URL("./fixtures/repositories/single-caller-shared/", import.meta.url);
    const projectFiles = await Promise.all([
      "src/format.ts",
      "src/cart.ts",
    ].map(async (filePath): Promise<ProjectFile> => ({
      filePath,
      source: await readFile(new URL(filePath, shared), "utf8"),
    })));
    const owner = projectFiles[0];
    expect(owner).toBeDefined();
    if (!owner) return;
    const candidate = extractCandidates(owner.filePath, owner.source)[0];
    expect(candidate).toBeDefined();
    if (!candidate) return;

    expect(buildSingleCallerExportedHelperEvidence(candidate, projectFiles))
      .toBeUndefined();
  });

  it("abstains when the only caller lives in a test file", () => {
    const helper = "export function formatCents(cents: number): string {\n"
      + "  return (cents / 100).toFixed(2);\n"
      + "}\n";
    const probe = "import { expect, it } from \"vitest\";\n"
      + "import { formatCents } from \"../src/helper.js\";\n"
      + "it(\"formats\", () => { expect(formatCents(5)).toBe(\"0.05\"); });\n";
    const projectFiles = [
      { filePath: "src/helper.ts", source: helper },
      { filePath: "test/helper.test.ts", source: probe },
    ];
    const candidate = extractCandidates("src/helper.ts", helper)[0];
    expect(candidate).toBeDefined();
    if (!candidate) return;

    expect(buildSingleCallerExportedHelperEvidence(candidate, projectFiles))
      .toBeUndefined();
  });

  it("names test callers alongside the single production caller", () => {
    const helper = "export function formatCents(cents: number): string {\n"
      + "  return (cents / 100).toFixed(2);\n"
      + "}\n";
    const app = "import { formatCents } from \"./helper.js\";\n"
      + "export function label(total: number): string {\n"
      + "  return `$${formatCents(total)}`;\n"
      + "}\n";
    const probe = "import { expect, it } from \"vitest\";\n"
      + "import { formatCents } from \"../src/helper.js\";\n"
      + "it(\"formats\", () => { expect(formatCents(5)).toBe(\"0.05\"); });\n";
    const projectFiles = [
      { filePath: "src/helper.ts", source: helper },
      { filePath: "src/app.ts", source: app },
      { filePath: "test/helper.test.ts", source: probe },
    ];
    const candidate = extractCandidates("src/helper.ts", helper)[0];
    expect(candidate).toBeDefined();
    if (!candidate) return;

    expect(buildSingleCallerExportedHelperEvidence(candidate, projectFiles)).toMatchObject({
      function: { name: "formatCents", exported: true },
      totalCallers: 1,
      caller: expect.objectContaining({ filePath: "src/app.ts" }),
      callerOwnership: "importing-module",
      testCallerCount: 1,
      testCallers: [expect.objectContaining({ filePath: "test/helper.test.ts" })],
      reexport: { reexported: false, reexportPaths: [] },
    });
  });

  it("fires with the callback-passing site as the lone caller", async () => {
    const source = await readFile(
      new URL("./fixtures/repositories/unused-export-map-ref/src/splitter.ts", import.meta.url),
      "utf8",
    );
    const projectFiles = [{ filePath: "src/splitter.ts", source }];
    const candidate = extractCandidates("src/splitter.ts", source)
      .find(({ source }) => source.includes("describeForSplitter(path"));
    expect(candidate).toBeDefined();
    if (!candidate) return;

    expect(buildSingleCallerExportedHelperEvidence(candidate, projectFiles)).toMatchObject({
      function: { name: "describeForSplitter", exported: true },
      totalCallers: 1,
      caller: expect.objectContaining({
        filePath: "src/splitter.ts",
        call: "files.map(describeForSplitter)",
        kind: "reference",
      }),
      callerOwnership: "same-file",
      reexport: { reexported: false, reexportPaths: [] },
    });
  });

  it("names the callback reference in judgment evidence through a fake evaluator", async () => {
    const source = await readFile(
      new URL("./fixtures/repositories/unused-export-map-ref/src/splitter.ts", import.meta.url),
      "utf8",
    );
    const projectFiles = [{ filePath: "src/splitter.ts", source }];
    const rule = defaultConfig.rules["jev/no-single-caller-exported-helper"];
    expect(rule).toBeDefined();
    if (!rule) return;
    const config: JevLintConfig = { rules: { "jev/no-single-caller-exported-helper": rule } };
    const evaluator: Evaluator = {
      async evaluate(request: EvaluationRequest): Promise<Record<string, number>> {
        return Object.fromEntries(Object.keys(request.questions).map((id) => [id, 0.79]));
      },
    };

    const result = await analyzeFileWithFailures({
      filePath: "src/splitter.ts",
      source,
      changedLines: [{ start: 1, end: 3 }],
      config,
      projectFiles,
    }, evaluator);

    expect(result.failures).toEqual([]);
    expect(result.judgments.map((judgment) => judgment.probability)).toEqual([0.79]);
    const [judgment] = result.judgments;
    expect(judgment?.ruleId).toBe("jev/no-single-caller-exported-helper");
    // SAFETY: rule evidence is a JSON object and this builder always sets the caller fields.
    const evidence = judgment?.evidence as { caller?: { call?: string; kind?: string } } | null;
    expect(evidence?.caller?.call).toBe("files.map(describeForSplitter)");
    expect(evidence?.caller?.kind).toBe("reference");
  });

  it("abstains for an unexported helper", () => {
    const source = [
      "function cents(cents: number) { return cents / 100; }",
      "export function label(total: number) { return `${cents(total)}`; }",
    ].join("\n");
    const candidate = extractCandidates("src/format.ts", source)
      .find(({ source }) => source.includes("function cents"));
    expect(candidate).toBeDefined();
    if (!candidate) return;

    expect(buildSingleCallerExportedHelperEvidence(candidate, [{ filePath: "src/format.ts", source }]))
      .toBeUndefined();
  });
});
