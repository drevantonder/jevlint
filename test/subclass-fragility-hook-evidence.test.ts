import { describe, expect, it } from "vitest";
import { extractCandidates } from "../src/candidates.js";
import { buildSubclassFragilityHookEvidence } from "../src/evidence/subclass-fragility-hook.js";
import type { ProjectFile } from "../src/types.js";

const BASE: ProjectFile = {
  filePath: "src/base.ts",
  source: "export type Row = { value: string };\n"
    + "export class ReportBuilder {\n"
    + "  build(rows: Row[]): string {\n"
    + "    const header = this.header();\n"
    + "    const lines = rows.map((row) => this.format(row));\n"
    + "    const withTotals = this.appendTotals(lines);\n"
    + "    const footer = this.footer();\n"
    + "    return [header, ...withTotals, footer].join(\"\\n\");\n"
    + "  }\n"
    + "  header(): string {\n"
    + "    return \"report\";\n"
    + "  }\n"
    + "  format(row: Row): string {\n"
    + "    return row.value;\n"
    + "  }\n"
    + "  appendTotals(lines: string[]): string[] {\n"
    + "    return [...lines, `total: ${lines.length}`];\n"
    + "  }\n"
    + "  footer(): string {\n"
    + "    return \"end\";\n"
    + "  }\n"
    + "}\n",
};

const COPIED_OVERRIDE = "import { ReportBuilder, Row } from \"./base\";\n"
  + "export class CsvReportBuilder extends ReportBuilder {\n"
  + "  build(rows: Row[]): string {\n"
  + "    const header = this.header();\n"
  + "    const lines = rows.map((row) => this.format(row));\n"
  + "    const withTotals = this.appendTotals(lines);\n"
  + "    const footer = this.footer();\n"
  + "    return [header, ...withTotals, footer].join(\",\");\n"
  + "  }\n"
  + "}\n";

const SUPER_OVERRIDE = "import { ReportBuilder, Row } from \"./base\";\n"
  + "export class UpperReportBuilder extends ReportBuilder {\n"
  + "  build(rows: Row[]): string {\n"
  + "    return super.build(rows).toUpperCase();\n"
  + "  }\n"
  + "}\n";

const PLAIN_FUNCTION = "export function build(rows: string[]): string {\n"
  + "  return rows.join(\",\");\n"
  + "}\n";

function methodCandidate(source: string, marker: string) {
  const projectFiles: ProjectFile[] = [
    { filePath: "src/csv.ts", source },
    BASE,
  ];
  const candidate = extractCandidates("src/csv.ts", source)
    .filter(({ kind }) => kind === "function")
    .find(({ source: text }) => text.includes(marker));
  expect(candidate).toBeDefined();
  if (!candidate) throw new Error("Fixture has no override candidate.");
  return { candidate, projectFiles };
}

describe("subclass fragility hook evidence", () => {
  it("flags an override that copies the base method with edits and no super call", () => {
    const { candidate, projectFiles } = methodCandidate(COPIED_OVERRIDE, 'join(",")');
    const evidence = buildSubclassFragilityHookEvidence(candidate, projectFiles);

    expect(evidence).toMatchObject({
      override: {
        className: "CsvReportBuilder",
        methodName: "build",
        filePath: "src/csv.ts",
        callsSuper: false,
      },
      base: {
        className: "ReportBuilder",
        ownership: "project-module",
        filePath: "src/base.ts",
        methodName: "build",
      },
    });
    expect(evidence?.similarity.ratio).toBeGreaterThanOrEqual(0.5);
  });

  it("abstains when the override reuses the base through super", () => {
    const { candidate, projectFiles } = methodCandidate(SUPER_OVERRIDE, "toUpperCase");
    expect(buildSubclassFragilityHookEvidence(candidate, projectFiles)).toBeUndefined();
  });

  it("abstains for a plain function that is not an override", () => {
    const projectFiles: ProjectFile[] = [{ filePath: "src/csv.ts", source: PLAIN_FUNCTION }, BASE];
    const candidate = extractCandidates("src/csv.ts", PLAIN_FUNCTION)
      .filter(({ kind }) => kind === "function")
      .find(({ source: text }) => text.includes("rows.join"));
    expect(candidate).toBeDefined();
    if (!candidate) throw new Error("Fixture has no function candidate.");
    expect(buildSubclassFragilityHookEvidence(candidate, projectFiles)).toBeUndefined();
  });
});
