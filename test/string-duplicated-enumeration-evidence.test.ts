import { readFile } from "node:fs/promises";
import { describe, expect, it } from "vitest";
import { buildStringDuplicatedEnumerationEvidence } from "../src/evidence/string-duplicated-enumeration.js";
import type { ProjectFile, SourceFile } from "../src/types.js";

const root = new URL("./fixtures/repositories/string-enumeration-smelly/", import.meta.url);

async function project(): Promise<{ changes: SourceFile[]; files: ProjectFile[] }> {
  const files = await Promise.all([
    "src/billing.ts",
    "src/reporting.ts",
  ].map(async (filePath): Promise<ProjectFile> => ({
    filePath,
    source: await readFile(new URL(filePath, root), "utf8"),
  })));
  const reporting = files.find((file) => file.filePath === "src/reporting.ts");
  if (!reporting) throw new Error("missing reporting fixture");
  const changes: SourceFile[] = [{
    filePath: reporting.filePath,
    source: reporting.source,
    oldSource: null,
    changedLines: [{ start: 1, end: reporting.source.split("\n").length }],
  }];
  return { changes, files };
}

describe("string duplicated enumeration evidence", () => {
  it("pairs restated changed-line literals with the owning union and import gap", async () => {
    const { changes, files } = await project();
    const evidence = buildStringDuplicatedEnumerationEvidence(
      {
        id: "change-0",
        kind: "change",
        filePath: "src/reporting.ts",
        source: "",
        start: 0,
        end: 0,
        startLine: 1,
        startColumn: 1,
        endLine: 1,
        endColumn: 1,
      },
      changes,
      files,
    );

    expect(evidence).toMatchObject({
      anchorFile: "src/reporting.ts",
      canonical: {
        filePath: "src/billing.ts",
        typeName: "BillingStatus",
        kind: "union",
      },
      importsOwner: false,
    });
    expect(evidence?.sharedLiterals).toEqual(["active", "archived", "paused"]);
    expect(evidence?.changedComparisons.length).toBeGreaterThan(0);
  });

  it("abstains when no other module owns the literal set as a type", () => {
    const source = [
      "export function greet(locale: string) {",
      "  if (locale === \"en\" || locale === \"fr\") return \"hi\";",
      "  return \"hello\";",
      "}",
    ].join("\n");
    const changes: SourceFile[] = [{
      filePath: "src/greet.ts",
      source,
      oldSource: null,
      changedLines: [{ start: 1, end: 4 }],
    }];

    expect(buildStringDuplicatedEnumerationEvidence(
      {
        id: "change-0",
        kind: "change",
        filePath: "src/greet.ts",
        source: "",
        start: 0,
        end: 0,
        startLine: 1,
        startColumn: 1,
        endLine: 1,
        endColumn: 1,
      },
      changes,
      [{ filePath: "src/greet.ts", source }],
    )).toBeUndefined();
  });
});
