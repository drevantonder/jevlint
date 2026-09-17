import { describe, expect, it } from "vitest";
import { buildFarAwayTestEvidence } from "../src/evidence/far-away-test.js";
import type { Candidate, ProjectFile, SourceFile } from "../src/types.js";

function projectFile(filePath: string, source = "export const value = 1;\n"): ProjectFile {
  return { filePath, source };
}

function moduleCandidate(filePath: string, kind: Candidate["kind"] = "module"): Candidate {
  return {
    id: "module_0",
    kind,
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

function change(filePath: string, source: string): SourceFile {
  return {
    filePath,
    source,
    oldSource: null,
    changedLines: [{ start: 1, end: source.split("\n").length }],
  };
}

function colocatedRepo(farTestPath: string, farTestSource: string) {
  const files: ProjectFile[] = [];
  const subjects = ["orders", "cart", "pricing", "refund", "ledger", "audit", "notify", "coupon"];
  for (const name of subjects) {
    files.push(projectFile(`src/${name}.ts`, `export function ${name}() { return 1; }\n`));
    files.push(projectFile(
      `src/${name}.test.ts`,
      `import { ${name} } from "./${name}.js";\nexport const check = ${name}();\n`,
    ));
  }
  files.push(projectFile("src/billing.ts", "export function billing() { return 1; }\n"));
  files.push(projectFile("tests/helpers.ts", "export const helper = 1;\n"));
  files.push(projectFile(farTestPath, farTestSource));
  return { files, changes: [change(farTestPath, farTestSource)] };
}

describe("far away test evidence", () => {
  it("captures a distant test with its subject and the repo colocation norm", () => {
    const farTest = 'import { billing } from "../src/billing.js";\nexport const check = billing();\n';
    const { files, changes } = colocatedRepo("tests/billing.test.ts", farTest);

    const evidence = buildFarAwayTestEvidence(moduleCandidate("tests/billing.test.ts"), files, changes);

    expect(evidence).toMatchObject({
      test: { filePath: "tests/billing.test.ts", dir: "tests", stem: "billing" },
      subject: { candidates: ["src/billing.ts"], dir: "src" },
      distanceSegments: 2,
      repoNorm: { testFiles: 10, colocated: 8 },
    });
    expect(evidence?.repoNorm.agreement).toBeCloseTo(8 / 10);
    expect(evidence?.module.dir).toBe("tests");
    expect(evidence?.module.truncated).toBe(false);
  });

  it("abstains when the test sits beside its subject", () => {
    const colocated = 'import { billing } from "./billing.js";\nexport const check = billing();\n';
    const files: ProjectFile[] = [];
    const subjects = ["orders", "cart", "pricing", "refund", "ledger", "audit"];
    for (const name of subjects) {
      files.push(projectFile(`src/${name}.ts`, `export function ${name}() { return 1; }\n`));
      files.push(projectFile(`src/${name}.test.ts`, `export const check = 1;\n`));
    }
    files.push(projectFile("src/billing.ts", "export function billing() { return 1; }\n"));
    files.push(projectFile("src/billing.test.ts", colocated));
    const changes = [change("src/billing.test.ts", colocated)];

    expect(buildFarAwayTestEvidence(moduleCandidate("src/billing.test.ts"), files, changes)).toBeUndefined();
  });

  it("abstains when fewer than five test files establish no norm", () => {
    const farTest = 'import { billing } from "../src/billing.js";\nexport const check = billing();\n';
    const files = [
      ...Array.from({ length: 9 }, (_, index) => projectFile(`src/filler-${index}.ts`)),
      projectFile("src/billing.ts", "export function billing() { return 1; }\n"),
      projectFile("tests/helpers.ts", "export const helper = 1;\n"),
      projectFile("tests/billing.test.ts", farTest),
    ];
    const changes = [change("tests/billing.test.ts", farTest)];

    expect(buildFarAwayTestEvidence(moduleCandidate("tests/billing.test.ts"), files, changes)).toBeUndefined();
  });

  it("abstains when the repo keeps tests in dedicated directories", () => {
    const files: ProjectFile[] = [];
    for (let index = 0; index < 6; index += 1) {
      files.push(projectFile(`src/widget-${index}.ts`, `export function widget${index}() { return 1; }\n`));
      files.push(projectFile(`__tests__/widget-${index}.test.ts`, `export const check = ${index};\n`));
    }
    files.push(projectFile("__tests__/helpers.ts", "export const helper = 1;\n"));
    const farTest = "export const check = 1;\n";
    files.push(projectFile("__tests__/billing.test.ts", farTest));
    const changes = [change("__tests__/billing.test.ts", farTest)];

    expect(
      buildFarAwayTestEvidence(moduleCandidate("__tests__/billing.test.ts"), files, changes),
    ).toBeUndefined();
  });

  it("abstains for framework-scaffolded paths and non-module candidates", () => {
    const farTest = 'import { billing } from "../../src/billing.js";\nexport const check = billing();\n';
    const { files, changes } = colocatedRepo("tests/billing.test.ts", farTest);
    const withApp = [
      ...files,
      projectFile("app/billing.test.ts", farTest),
      projectFile("app/helpers.ts", "export const helper = 1;\n"),
    ];

    expect(buildFarAwayTestEvidence(moduleCandidate("app/billing.test.ts"), withApp, changes)).toBeUndefined();
    expect(buildFarAwayTestEvidence(moduleCandidate("tests/billing.test.ts", "function"), files, changes))
      .toBeUndefined();
    expect(buildFarAwayTestEvidence(moduleCandidate("src/orders.ts"), files, [])).toBeUndefined();
  });
});
