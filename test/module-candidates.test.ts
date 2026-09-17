import { describe, expect, it } from "vitest";
import { analyzeModulesWithFailures } from "../src/analyze.js";
import { extractModuleCandidates } from "../src/candidates.js";
import { defaultConfig } from "../src/config.js";
import { buildFarAwayTestEvidence } from "../src/evidence/far-away-test.js";
import { buildModuleEvidence } from "../src/evidence/module.js";
import type {
  Candidate,
  EvaluationRequest,
  Evaluator,
  JevLintConfig,
  ProjectFile,
  SourceFile,
} from "../src/types.js";

class StubEvaluator implements Evaluator {
  requests: EvaluationRequest[] = [];

  async evaluate(request: EvaluationRequest): Promise<Record<string, number>> {
    this.requests.push(request);
    return Object.fromEntries(Object.keys(request.questions).map((id) => [id, 0.8]));
  }
}

function projectFile(filePath: string, source = "export const value = 1;\n"): ProjectFile {
  return { filePath, source };
}

function filler(count: number, prefix = "src/filler"): ProjectFile[] {
  return Array.from({ length: count }, (_, index) => projectFile(`${prefix}-${index}.ts`));
}

function moduleCandidate(filePath: string): Candidate {
  return {
    id: "module_0",
    kind: "module",
    filePath,
    source: "",
    start: 0,
    end: 0,
    startLine: 1,
    startColumn: 1,
    endLine: 1,
    endColumn: 1,
  };
}

function change(
  filePath: string,
  source: string,
  oldSource: string | null = null,
): SourceFile {
  return {
    filePath,
    source,
    oldSource,
    changedLines: [{ start: 1, end: source.split("\n").length }],
  };
}

describe("extractModuleCandidates", () => {
  it("emits exactly one module candidate per added file", () => {
    const changes = [change("src/new.ts", "export const value = 1;\n")];
    const files = [...filler(10), projectFile("src/new.ts", changes[0]!.source)];

    const candidates = extractModuleCandidates(changes, files);

    expect(candidates).toHaveLength(1);
    expect(candidates[0]).toMatchObject({
      id: "module_0",
      kind: "module",
      filePath: "src/new.ts",
      source: "",
      startLine: 1,
      startColumn: 1,
      endLine: 1,
      endColumn: 1,
    });
  });

  it("emits for import-list changes but not pure body edits", () => {
    const before = 'import { a } from "./a.js";\nexport const value = a(1);\n';
    const afterImports = 'import { a } from "./a.js";\nimport { b } from "./b.js";\nexport const value = a(b(1));\n';
    const afterBody = 'import { a } from "./a.js";\nexport const value = a(2);\n';
    const changes = [
      change("src/imports.ts", afterImports, before),
      change("src/body.ts", afterBody, before),
    ];
    const files = [
      ...filler(10),
      projectFile("src/a.ts"),
      projectFile("src/b.ts"),
      projectFile("src/imports.ts", afterImports),
      projectFile("src/body.ts", afterBody),
    ];

    const candidates = extractModuleCandidates(changes, files);

    expect(candidates.map(({ filePath }) => filePath)).toEqual(["src/imports.ts"]);
  });

  it("emits for export-list changes on modified files", () => {
    const before = "export function formatDate(value: Date) { return value; }\n";
    const after = `${before}export function calculateTax(value: number) { return value; }\n`;
    const changes = [change("src/utils.ts", after, before)];
    const files = [...filler(10), projectFile("src/utils.ts", after)];

    const candidates = extractModuleCandidates(changes, files);

    expect(candidates.map(({ filePath }) => filePath)).toEqual(["src/utils.ts"]);
  });

  it("caps emission at 50 files with deterministic order", () => {
    const changes = Array.from(
      { length: 60 },
      (_, index) => change(`src/new-${String(index).padStart(2, "0")}.ts`, "export const value = 1;\n"),
    );
    const files = changes.map(({ filePath, source }) => projectFile(filePath, source));

    const candidates = extractModuleCandidates(changes, files);

    expect(candidates).toHaveLength(50);
    expect(candidates[0]?.id).toBe("module_0");
    expect(candidates[49]?.id).toBe("module_49");
    expect(candidates[0]?.filePath).toBe("src/new-00.ts");
  });

  it("records omitted files in coverage metadata", () => {
    const changes = Array.from(
      { length: 55 },
      (_, index) => change(`src/new-${String(index).padStart(2, "0")}.ts`, "export const value = 1;\n"),
    );
    const files = changes.map(({ filePath, source }) => projectFile(filePath, source));

    const evidence = buildModuleEvidence("src/new-00.ts", changes, files);

    expect(evidence?.coverage).toMatchObject({ evaluatedFiles: 50, omittedFiles: 5 });
    expect(evidence?.truncated).toBe(true);
  });
});

describe("module abstention gates", () => {
  it("abstains when the repo has fewer than 10 source files", () => {
    const files = [...filler(5), projectFile("tests/billing.test.ts", "export const test = 1;\n")];
    const candidate = moduleCandidate("tests/billing.test.ts");

    expect(buildModuleEvidence(candidate.filePath, [], files)).toBeUndefined();
    expect(buildFarAwayTestEvidence(candidate, files, [])).toBeUndefined();
  });

  it("abstains for a new top-level directory with no siblings", () => {
    const added = change("billing/invoice.ts", "export const invoice = 1;\n");
    const files = [...filler(10), projectFile("billing/invoice.ts", added.source)];

    expect(buildModuleEvidence("billing/invoice.ts", [added], files)).toBeUndefined();
  });

  it("keeps added files in directories that already have siblings", () => {
    const added = change("src/new.ts", "export const value = 1;\n");
    const files = [...filler(10), projectFile("src/new.ts", added.source)];

    expect(buildModuleEvidence("src/new.ts", [added], files)).toBeDefined();
  });
});

describe("analyzeModulesWithFailures", () => {
  function colocatedRepo() {
    const files: ProjectFile[] = [];
    const subjects = ["orders", "cart", "pricing", "refund", "ledger", "audit", "notify", "coupon"];
    for (const name of subjects) {
      files.push(projectFile(`src/${name}.ts`, `export function ${name}() { return 1; }\n`));
      files.push(projectFile(
        `src/${name}.test.ts`,
        `import { ${name} } from "./${name}.js";\nexport const check = ${name}();\n`,
      ));
    }
    const farTest = 'import { billing } from "../src/billing.js";\nexport const check = billing();\n';
    files.push(projectFile("src/billing.ts", "export function billing() { return 1; }\n"));
    files.push(projectFile("tests/helpers.ts", "export const helper = 1;\n"));
    files.push(projectFile("tests/billing.test.ts", farTest));
    const changes = [change("tests/billing.test.ts", farTest)];
    return { files, changes };
  }

  it("judges module candidates once per matching rule", async () => {
    const { files, changes } = colocatedRepo();
    const rule = defaultConfig.rules["jev/no-far-away-test"];
    expect(rule).toBeDefined();
    if (!rule) return;
    const config: JevLintConfig = { rules: { "jev/no-far-away-test": rule } };
    const evaluator = new StubEvaluator();

    const result = await analyzeModulesWithFailures({ changes, config, projectFiles: files }, evaluator);

    expect(result.failures).toEqual([]);
    expect(result.judgments).toHaveLength(1);
    expect(result.judgments[0]).toMatchObject({
      ruleId: "jev/no-far-away-test",
      candidateKind: "module",
      filePath: "tests/billing.test.ts",
      probability: 0.8,
    });
    expect(result.judgments[0]?.evidence).toBeTruthy();
    expect(evaluator.requests).toHaveLength(1);
  });

  it("returns no questions when no module-scope rule is configured", async () => {
    const { files, changes } = colocatedRepo();
    const rule = defaultConfig.rules["jev/no-pass-through-wrapper"];
    expect(rule).toBeDefined();
    if (!rule) return;
    const config: JevLintConfig = { rules: { "jev/no-pass-through-wrapper": rule } };
    const evaluator = new StubEvaluator();

    const result = await analyzeModulesWithFailures({ changes, config, projectFiles: files }, evaluator);

    expect(result).toMatchObject({ judgments: [], abstentions: [], failures: [] });
    expect(evaluator.requests).toHaveLength(0);
  });

  it("records structural abstentions instead of low scores", async () => {
    const files = filler(12);
    const farTest = "export const check = 1;\n";
    const withTest = [...files, projectFile("tests/lonely.test.ts", farTest)];
    const changes = [change("tests/lonely.test.ts", farTest)];
    const rule = defaultConfig.rules["jev/no-far-away-test"];
    expect(rule).toBeDefined();
    if (!rule) return;
    const config: JevLintConfig = { rules: { "jev/no-far-away-test": rule } };

    const result = await analyzeModulesWithFailures(
      { changes, config, projectFiles: withTest },
      new StubEvaluator(),
    );

    expect(result.judgments).toEqual([]);
    expect(result.abstentions).toEqual([
      { ruleId: "jev/no-far-away-test", candidateKind: "module", count: 1 },
    ]);
  });
});
