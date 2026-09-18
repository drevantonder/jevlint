import { readFile } from "node:fs/promises";
import { describe, expect, it } from "vitest";
import { analyzeFileWithFailures } from "../src/analyze.js";
import { extractCandidates } from "../src/candidates.js";
import { defaultConfig } from "../src/config.js";
import { buildPhantomPackageImportEvidence } from "../src/evidence/phantom-package-import.js";
import type {
  EvaluationRequest,
  Evaluator,
  JevLintConfig,
  ProjectFile,
} from "../src/types.js";

const repositories = new URL("./fixtures/repositories/", import.meta.url);

async function project(name: string, paths: string[]): Promise<ProjectFile[]> {
  return Promise.all(paths.map(async (filePath) => ({
    filePath,
    source: await readFile(new URL(`${name}/${filePath}`, repositories), "utf8"),
  })));
}

function candidateFor(owner: ProjectFile, needle: string) {
  return extractCandidates(owner.filePath, owner.source)
    .filter(({ kind, source }) => kind === "function" && source.includes(needle))
    .sort((left, right) => left.source.length - right.source.length)[0];
}

describe("phantom package import evidence", () => {
  it("flags an import absent from every manifest and lockfile", async () => {
    const projectFiles = await project("phantom-positive", [
      "src/main.ts",
      "package.json",
    ]);
    const owner = projectFiles[0];
    expect(owner).toBeDefined();
    if (!owner) return;
    const candidate = candidateFor(owner, "convertTimestamp");
    expect(candidate).toBeDefined();
    if (!candidate) return;

    expect(buildPhantomPackageImportEvidence(candidate, projectFiles)).toMatchObject({
      imports: [
        {
          source: "date-fns-tz-extended",
          kind: "undeclared",
          declaredIn: null,
          lockfileHit: false,
        },
      ],
      manifest: { filePath: "package.json" },
      lockfilesChecked: [],
    });
  });

  it("passes declared, locked, builtin, and relative imports", async () => {
    const projectFiles = await project("phantom-negative", [
      "src/main.ts",
      "src/util.ts",
      "package.json",
      "package-lock.json",
    ]);
    const owner = projectFiles[0];
    expect(owner).toBeDefined();
    if (!owner) return;
    const candidate = candidateFor(owner, "renderStamp");
    expect(candidate).toBeDefined();
    if (!candidate) return;

    const evidence = buildPhantomPackageImportEvidence(candidate, projectFiles);
    expect(evidence).toMatchObject({
      imports: expect.arrayContaining([
        { source: "date-fns", kind: "declared", declaredIn: "dependencies", lockfileHit: true, aliasMapped: false },
        expect.objectContaining({ source: "./util.js", kind: "relative" }),
      ]),
    });
    expect(evidence?.imports.map((entry) => entry.source)).not.toContain("node:path");
  });

  it("abstains on node:-prefixed builtin imports", async () => {
    const projectFiles = await project("phantom-builtin", [
      "src/prefixed.ts",
      "src/bare.ts",
      "package.json",
    ]);
    const owner = projectFiles[0];
    expect(owner).toBeDefined();
    if (!owner) return;
    const candidate = candidateFor(owner, "loadPrefixed");
    expect(candidate).toBeDefined();
    if (!candidate) return;

    expect(buildPhantomPackageImportEvidence(candidate, projectFiles)).toBeUndefined();
  });

  it("abstains on bare builtin names", async () => {
    const projectFiles = await project("phantom-builtin", [
      "src/prefixed.ts",
      "src/bare.ts",
      "package.json",
    ]);
    const owner = projectFiles[1];
    expect(owner).toBeDefined();
    if (!owner) return;
    const candidate = candidateFor(owner, "locateBare");
    expect(candidate).toBeDefined();
    if (!candidate) return;

    expect(buildPhantomPackageImportEvidence(candidate, projectFiles)).toBeUndefined();
  });

  it("abstains when the function imports nothing", async () => {
    const owner: ProjectFile = {
      filePath: "src/plain.ts",
      source: "export function double(value: number): number {\n  return value * 2;\n}\n",
    };
    const candidate = candidateFor(owner, "double");
    expect(candidate).toBeDefined();
    if (!candidate) return;

    expect(buildPhantomPackageImportEvidence(candidate, [owner])).toBeUndefined();
  });

  it("asks about genuinely undeclared imports while abstaining on builtins", async () => {
    const rule = defaultConfig.rules["jev/no-phantom-package-import"];
    expect(rule).toBeDefined();
    if (!rule) return;
    const config: JevLintConfig = { rules: { "jev/no-phantom-package-import": rule } };
    const evaluator = new StubEvaluator();

    const positive = await project("phantom-positive", ["src/main.ts", "package.json"]);
    const changed = positive[0];
    expect(changed).toBeDefined();
    if (!changed) return;
    const positiveResult = await analyzeFileWithFailures({
      filePath: changed.filePath,
      source: changed.source,
      changedLines: [{ start: 1, end: changed.source.split("\n").length }],
      config,
      projectFiles: positive,
    }, evaluator);
    expect(positiveResult.failures).toEqual([]);
    expect(positiveResult.statistics.questions).toBe(1);
    expect(positiveResult.judgments.map(({ ruleId }) => ruleId)).toEqual([
      "jev/no-phantom-package-import",
    ]);
    // SAFETY: buildPhantomPackageImportEvidence always emits an object with an imports array for this rule id.
    const asked = evaluator.requests[0]?.state.candidates[0]?.evidence?.[
      "jev/no-phantom-package-import"
    ] as { imports: { source: string; kind: string }[] } | undefined;
    expect(asked?.imports).toMatchObject([
      { source: "date-fns-tz-extended", kind: "undeclared" },
    ]);

    const builtin = await project("phantom-builtin", [
      "src/prefixed.ts",
      "src/bare.ts",
      "package.json",
    ]);
    const builtinOwner = builtin[0];
    expect(builtinOwner).toBeDefined();
    if (!builtinOwner) return;
    const builtinEvaluator = new StubEvaluator();
    const builtinResult = await analyzeFileWithFailures({
      filePath: builtinOwner.filePath,
      source: builtinOwner.source,
      changedLines: [{ start: 1, end: builtinOwner.source.split("\n").length }],
      config,
      projectFiles: builtin,
    }, builtinEvaluator);
    expect(builtinResult.failures).toEqual([]);
    expect(builtinResult.statistics.questions).toBe(0);
    expect(builtinResult.judgments).toEqual([]);
    expect(builtinResult.abstentions).toContainEqual({
      ruleId: "jev/no-phantom-package-import",
      candidateKind: "function",
      count: 1,
    });
    expect(builtinEvaluator.requests).toEqual([]);
  });
});

class StubEvaluator implements Evaluator {
  requests: EvaluationRequest[] = [];

  async evaluate(request: EvaluationRequest): Promise<Record<string, number>> {
    this.requests.push(request);
    return Object.fromEntries(Object.keys(request.questions).map((id) => [id, 0.9]));
  }
}
