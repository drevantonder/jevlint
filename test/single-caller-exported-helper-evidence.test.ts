import { execFile as execFileCallback } from "node:child_process";
import { mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { describe, expect, it } from "vitest";
import { analyzeFileWithFailures } from "../src/analyze.js";
import { extractCandidates } from "../src/candidates.js";
import { defaultConfig } from "../src/config.js";
import { buildSingleCallerExportedHelperEvidence, clearSingleCallerCoChangeCache } from "../src/evidence/single-caller-exported-helper.js";
import type { Candidate, EvaluationRequest, Evaluator, JevLintConfig, ProjectFile } from "../src/types.js";

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
      sameFileCaller: true,
      reexport: { reexported: false, reexportPaths: [] },
      testContracts: { directCount: 0, transitiveCount: 0 },
      publicReachability: { exportsMapPresent: false, viaBarrel: false, reachable: false },
      coChange: { available: false, reason: "no-repo-configured" },
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

const execFile = promisify(execFileCallback);
const CO_CHANGE_ENV = "JEVLINT_COHANGE_REPO";

function candidateFor(filePath: string, source: string, needle: string): Candidate | undefined {
  return extractCandidates(filePath, source).find(({ source: text }) => text.includes(needle));
}

describe("single caller keep-signal facts", () => {
  it("marks direct contract tests separately from transitive test pins", () => {
    const helper = "export function formatCents(cents: number): string {\n"
      + "  return (cents / 100).toFixed(2);\n"
      + "}\n";
    const app = "import { formatCents } from \"./helper.js\";\n"
      + "export function label(total: number): string {\n"
      + "  return `$${formatCents(total)}`;\n"
      + "}\n";
    const directProbe = "import { expect, it } from \"vitest\";\n"
      + "import { formatCents } from \"../src/helper.js\";\n"
      + "it(\"formats\", () => { expect(formatCents(5)).toBe(\"0.05\"); });\n";
    const transitiveProbe = "import { expect, it } from \"vitest\";\n"
      + "import { label } from \"../src/app.js\";\n"
      + "it(\"labels\", () => { expect(label(5)).toBe(\"$0.05\"); });\n";
    const projectFiles = [
      { filePath: "src/helper.ts", source: helper },
      { filePath: "src/app.ts", source: app },
      { filePath: "test/helper.test.ts", source: directProbe },
      { filePath: "test/label.test.ts", source: transitiveProbe },
    ];
    const candidate = candidateFor("src/helper.ts", helper, "formatCents");
    expect(candidate).toBeDefined();
    if (!candidate) return;

    const evidence = buildSingleCallerExportedHelperEvidence(candidate, projectFiles);
    expect(evidence).toMatchObject({
      totalCallers: 1,
      sameFileCaller: false,
      callerOwnership: "importing-module",
      testContracts: {
        directCount: 1,
        transitiveCount: 1,
        direct: [expect.objectContaining({ filePath: "test/helper.test.ts" })],
        transitive: [expect.objectContaining({
          test: "test/label.test.ts",
          seam: "label",
          seamFile: "src/app.ts",
        })],
      },
    });
    expect(evidence?.testContracts.direct.some(({ filePath }) => filePath === "test/label.test.ts")).toBe(false);
  });

  it("reports exports-map and barrel reachability as public API facts", () => {
    const helper = "export function formatCents(cents: number): string {\n"
      + "  return (cents / 100).toFixed(2);\n"
      + "}\n";
    const app = "import { formatCents } from \"./helper.js\";\n"
      + "export function label(total: number): string {\n"
      + "  return `$${formatCents(total)}`;\n"
      + "}\n";
    const barrel = "export { formatCents } from \"./helper.js\";\n";
    const manifest = JSON.stringify({
      name: "cart",
      exports: { ".": "./dist/index.js", "./helper": "./dist/helper.js" },
    });
    const projectFiles = [
      { filePath: "src/helper.ts", source: helper },
      { filePath: "src/app.ts", source: app },
      { filePath: "src/index.ts", source: barrel },
      { filePath: "package.json", source: manifest },
    ];
    const candidate = candidateFor("src/helper.ts", helper, "formatCents");
    expect(candidate).toBeDefined();
    if (!candidate) return;

    const evidence = buildSingleCallerExportedHelperEvidence(candidate, projectFiles);
    expect(evidence?.reexport.reexported).toBe(true);
    expect(evidence?.publicReachability).toEqual({
      exportsMapPresent: true,
      exportsMentionsOwner: true,
      barrelFile: "src/index.ts",
      viaBarrel: true,
      reachable: true,
    });
  });

  it("treats absent-from-both maps as a neutral fact without abstaining", () => {
    const helper = "export function formatCents(cents: number): string {\n"
      + "  return (cents / 100).toFixed(2);\n"
      + "}\n";
    const app = "import { formatCents } from \"./helper.js\";\n"
      + "export function label(total: number): string {\n"
      + "  return `$${formatCents(total)}`;\n"
      + "}\n";
    const projectFiles = [
      { filePath: "src/helper.ts", source: helper },
      { filePath: "src/app.ts", source: app },
    ];
    const candidate = candidateFor("src/helper.ts", helper, "formatCents");
    expect(candidate).toBeDefined();
    if (!candidate) return;

    const evidence = buildSingleCallerExportedHelperEvidence(candidate, projectFiles);
    expect(evidence?.publicReachability).toEqual({
      exportsMapPresent: false,
      exportsMentionsOwner: false,
      barrelFile: null,
      viaBarrel: false,
      reachable: false,
    });
  });

  it("carries the keep-signal facts through a fake evaluator", async () => {
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
      filePath: "src/helper.ts",
      source: helper,
      changedLines: [{ start: 1, end: helper.split("\n").length }],
      config,
      projectFiles,
    }, evaluator);

    expect(result.failures).toEqual([]);
    expect(result.judgments.map((judgment) => judgment.probability)).toEqual([0.42]);
    const judged = result.judgments[0];
    expect(judged?.ruleId).toBe("jev/no-single-caller-exported-helper");
    // SAFETY: rule evidence is a JSON object and this builder sets these keep-signal facts on every firing.
    const evidence = judged?.evidence as {
      sameFileCaller?: boolean;
      testContracts?: { directCount?: number; transitiveCount?: number };
      publicReachability?: { reachable?: boolean };
      coChange?: { available?: boolean };
    } | null;
    expect(evidence?.sameFileCaller).toBe(false);
    expect(evidence?.testContracts).toMatchObject({ directCount: 1, transitiveCount: 0 });
    expect(evidence?.publicReachability).toMatchObject({ reachable: false });
    expect(evidence?.coChange).toMatchObject({ available: false });
  });
});

describe("single caller co-change history", () => {
  const helperSource = "export function formatCents(cents: number): string {\n"
    + "  return (cents / 100).toFixed(2);\n"
    + "}\n";
  const callerSource = "import { formatCents } from \"./helper.js\";\n"
    + "export function label(total: number): string {\n"
    + "  return `$${formatCents(total)}`;\n"
    + "}\n";

  async function commitAll(cwd: string, message: string): Promise<void> {
    await execFile("git", ["add", "."], { cwd });
    await execFile("git", ["commit", "-qm", message], { cwd });
  }

  async function scaffoldRepo(evolveHelper: boolean): Promise<{ cwd: string; prior: string | undefined }> {
    const cwd = await mkdtemp(join(tmpdir(), "jevlint-cochange-"));
    await execFile("git", ["init", "-q"], { cwd });
    await execFile("git", ["config", "user.name", "Test"], { cwd });
    await execFile("git", ["config", "user.email", "test@example.com"], { cwd });
    await mkdir(join(cwd, "src"), { recursive: true });
    await writeFile(join(cwd, "src", "helper.ts"), helperSource);
    await execFile("git", ["add", "src/helper.ts"], { cwd });
    await execFile("git", ["commit", "-qm", "scaffold helper"], { cwd });
    await writeFile(join(cwd, "src", "app.ts"), callerSource);
    await execFile("git", ["add", "src/app.ts"], { cwd });
    await execFile("git", ["commit", "-qm", "scaffold caller"], { cwd });
    await writeFile(join(cwd, "src", "app.ts"), `${callerSource}export const version = 2;\n`);
    if (evolveHelper) {
      await writeFile(join(cwd, "src", "helper.ts"), `${helperSource}export const scale = 100;\n`);
    }
    await commitAll(cwd, "evolve caller");
    const prior = process.env[CO_CHANGE_ENV];
    process.env[CO_CHANGE_ENV] = cwd;
    clearSingleCallerCoChangeCache();
    return { cwd, prior };
  }

  function restoreEnv(prior: string | undefined): void {
    if (prior === undefined) delete process.env[CO_CHANGE_ENV];
    else process.env[CO_CHANGE_ENV] = prior;
    clearSingleCallerCoChangeCache();
  }

  function projectFiles(): ProjectFile[] {
    return [
      { filePath: "src/helper.ts", source: helperSource },
      { filePath: "src/app.ts", source: callerSource },
    ];
  }

  it("reads untouched-since-scaffold with zero co-change ripple as a seam-holds fact", async () => {
    const { prior } = await scaffoldRepo(false);
    try {
      const files = projectFiles();
      const candidate = candidateFor("src/helper.ts", helperSource, "formatCents");
      expect(candidate).toBeDefined();
      if (!candidate) return;
      const evidence = buildSingleCallerExportedHelperEvidence(candidate, files);
      expect(evidence?.coChange).toEqual({
        available: true,
        commitCap: 20,
        helperCommits: 1,
        callerCommits: 2,
        sharedCommits: 0,
        truncated: false,
        untouchedSinceScaffold: true,
        seamHolds: true,
      });
    } finally {
      restoreEnv(prior);
    }
  });

  it("withholds seam-holds once the helper evolves with its caller", async () => {
    const { prior } = await scaffoldRepo(true);
    try {
      const files = projectFiles();
      const candidate = candidateFor("src/helper.ts", helperSource, "formatCents");
      expect(candidate).toBeDefined();
      if (!candidate) return;
      const evidence = buildSingleCallerExportedHelperEvidence(candidate, files);
      expect(evidence?.coChange).toMatchObject({
        available: true,
        untouchedSinceScaffold: false,
        seamHolds: false,
      });
      const coChange = evidence?.coChange;
      expect(coChange?.available).toBe(true);
      if (coChange?.available === true) {
        expect(coChange.sharedCommits).toBeGreaterThan(0);
      }
    } finally {
      restoreEnv(prior);
    }
  });

  it("stays within ~50ms per file on a 5-file sample versus the no-repo path", async () => {
    const { prior } = await scaffoldRepo(false);
    try {
      const variants: { filePath: string; source: string }[][] = [];
      for (let index = 0; index < 5; index += 1) {
        const suffix = index === 0 ? "" : `${index}`;
        const helperPath = `src/helper${suffix}.ts`;
        const appPath = `src/app${suffix}.ts`;
        await writeFile(join(process.env[CO_CHANGE_ENV] ?? "", helperPath), helperSource);
        await writeFile(join(process.env[CO_CHANGE_ENV] ?? "", appPath), callerSource);
        variants.push([
          { filePath: helperPath, source: helperSource },
          { filePath: appPath, source: callerSource },
        ]);
      }
      await commitAll(process.env[CO_CHANGE_ENV] ?? "", "sample variants");
      clearSingleCallerCoChangeCache();

      const withRepoStart = performance.now();
      for (const files of variants) {
        const candidate = candidateFor(files[0]?.filePath ?? "", files[0]?.source ?? "", "formatCents");
        expect(candidate).toBeDefined();
        if (!candidate) continue;
        buildSingleCallerExportedHelperEvidence(candidate, files);
      }
      const withRepoMs = performance.now() - withRepoStart;

      delete process.env[CO_CHANGE_ENV];
      clearSingleCallerCoChangeCache();
      const withoutRepoStart = performance.now();
      for (const files of variants) {
        const candidate = candidateFor(files[0]?.filePath ?? "", files[0]?.source ?? "", "formatCents");
        expect(candidate).toBeDefined();
        if (!candidate) continue;
        buildSingleCallerExportedHelperEvidence(candidate, files);
      }
      const withoutRepoMs = performance.now() - withoutRepoStart;

      const perFileMs = withRepoMs / variants.length;
      process.stdout.write(
        `co-change cost: with-repo ${withRepoMs.toFixed(1)}ms vs without-repo ${withoutRepoMs.toFixed(1)}ms`
        + ` across ${variants.length} files (${perFileMs.toFixed(1)}ms/file)\n`,
      );
      expect(perFileMs).toBeLessThan(50);
    } finally {
      restoreEnv(prior);
    }
  });
});
