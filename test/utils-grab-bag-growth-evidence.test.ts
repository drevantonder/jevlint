import { describe, expect, it } from "vitest";
import { buildUtilsGrabBagGrowthEvidence } from "../src/evidence/utils-grab-bag-growth.js";
import type { Candidate, ProjectFile, SourceFile } from "../src/types.js";

function projectFile(filePath: string, source = "export const value = 1;\n"): ProjectFile {
  return { filePath, source };
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

const beforeUtils = `export function formatDate(value: Date) {
  return value.toISOString();
}
export function hashToken(token: string) {
  return token.length;
}
export function capitalizeName(name: string) {
  return name.toUpperCase();
}
`;

const afterUtils = `${beforeUtils}export function calculateInvoiceTax(amount: number) {
  return amount * 0.2;
}
`;

function repo(after: string) {
  const files = Array.from({ length: 10 }, (_, index) => projectFile(`src/filler-${index}.ts`));
  files.push(projectFile("src/utils.ts", after));
  files.push(projectFile("src/billing.ts", 'import { calculateInvoiceTax } from "./utils.js";\nexport const tax = calculateInvoiceTax(1);\n'));
  const changes: SourceFile[] = [{
    filePath: "src/utils.ts",
    source: after,
    oldSource: beforeUtils,
    changedLines: [{ start: 10, end: 12 }],
  }];
  return { files, changes };
}

describe("utils grab bag growth evidence", () => {
  it("captures an unrelated invoice export added to a miscellaneous module", () => {
    const { files, changes } = repo(afterUtils);

    const evidence = buildUtilsGrabBagGrowthEvidence(moduleCandidate("src/utils.ts"), files, changes);

    expect(evidence?.addedExports).toEqual(["calculateInvoiceTax"]);
    expect(evidence?.existingDomains.length).toBeGreaterThanOrEqual(3);
    expect(evidence?.beforeExports).toEqual(
      expect.arrayContaining(["formatDate", "hashToken", "capitalizeName"]),
    );
    expect(evidence?.afterExports).toContain("calculateInvoiceTax");
    expect(evidence?.importerTopics).toContain("src");
    expect(evidence?.module.dir).toBe("src");
  });

  it("abstains when the added export shares an existing domain", () => {
    const after = `${beforeUtils}export function formatTime(value: Date) {
  return value.getTime();
}
`;
    const { files, changes } = repo(after);

    expect(buildUtilsGrabBagGrowthEvidence(moduleCandidate("src/utils.ts"), files, changes)).toBeUndefined();
  });

  it("abstains when the host spans fewer than three domains", () => {
    const narrowBefore = `export function formatDate(value: Date) {
  return value.toISOString();
}
export function formatTime(value: Date) {
  return value.getTime();
}
`;
    const narrowAfter = `${narrowBefore}export function calculateInvoiceTax(amount: number) {
  return amount * 0.2;
}
`;
    const files = Array.from({ length: 10 }, (_, index) => projectFile(`src/filler-${index}.ts`));
    files.push(projectFile("src/utils.ts", narrowAfter));
    const changes: SourceFile[] = [{
      filePath: "src/utils.ts",
      source: narrowAfter,
      oldSource: narrowBefore,
      changedLines: [{ start: 7, end: 9 }],
    }];

    expect(buildUtilsGrabBagGrowthEvidence(moduleCandidate("src/utils.ts"), files, changes)).toBeUndefined();
  });

  it("abstains for owned homes, added files, and repos without a norm", () => {
    const { files, changes } = repo(afterUtils);

    expect(buildUtilsGrabBagGrowthEvidence(moduleCandidate("src/billing.ts"), files, changes)).toBeUndefined();
    const addedChanges: SourceFile[] = [{
      filePath: "src/utils.ts",
      source: afterUtils,
      oldSource: null,
      changedLines: [{ start: 1, end: 12 }],
    }];
    expect(buildUtilsGrabBagGrowthEvidence(moduleCandidate("src/utils.ts"), files, addedChanges)).toBeUndefined();
    expect(buildUtilsGrabBagGrowthEvidence(moduleCandidate("src/utils.ts"), files.slice(0, 5), changes))
      .toBeUndefined();
  });

  it("abstains for framework-scaffolded miscellaneous paths", () => {
    const { files } = repo(afterUtils);
    const withApp = [
      ...files,
      projectFile("app/utils.ts", afterUtils),
      projectFile("app/screen.ts", "export const screen = 1;\n"),
    ];
    const appChanges: SourceFile[] = [{
      filePath: "app/utils.ts",
      source: afterUtils,
      oldSource: beforeUtils,
      changedLines: [{ start: 10, end: 12 }],
    }];

    expect(buildUtilsGrabBagGrowthEvidence(moduleCandidate("app/utils.ts"), withApp, appChanges)).toBeUndefined();
  });
});
