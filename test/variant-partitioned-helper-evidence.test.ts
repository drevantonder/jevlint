import { describe, expect, it } from "vitest";
import { extractCandidates } from "../src/candidates.js";
import { buildVariantPartitionedHelperEvidence } from "../src/evidence/variant-partitioned-helper.js";
import type { ProjectFile } from "../src/types.js";

const reportSource = `export function renderReport(format: string, rows: string[]): string {
  if (format === "json") {
    const copies: string[] = [];
    for (const row of rows) {
      copies.push(row);
    }
    return JSON.stringify(copies);
  }
  if (format === "csv") {
    const header = "rows\\n";
    return header + rows.join("\\n");
  }
  throw new Error("unknown format " + format);
}
`;

const pageSource = `import { renderReport } from "./report.js";

export function jsonPage(rows: string[]): string {
  return renderReport("json", rows);
}

export function csvPage(rows: string[]): string {
  return renderReport("csv", rows);
}

export function dynamicPage(format: string, rows: string[]): string {
  return renderReport(format, rows);
}
`;

const bagSource = `export function renderBag(options: { format: string }, rows: string[]): string {
  if (options.format === "json") {
    const body = JSON.stringify(rows);
    return body.toUpperCase();
  }
  if (options.format === "csv") {
    return rows.join("\\n");
  }
  throw new Error("unknown format " + options.format);
}
`;

const bagCaller = `import { renderBag } from "./bag.js";

export function jsonBag(rows: string[]): string {
  return renderBag({ format: "json" }, rows);
}

export function csvBag(rows: string[]): string {
  return renderBag({ format: "csv" }, rows);
}
`;

function candidate(source: string, filePath: string, name: string) {
  const found = extractCandidates(filePath, source).find(
    ({ kind, source: span }) => kind === "function" && span.includes(name),
  );
  expect(found?.kind).toBe("function");
  return found;
}

describe("variant partitioned helper evidence", () => {
  it("extracts a string discriminant with per-variant arms and partitioned callers", () => {
    const files: ProjectFile[] = [
      { filePath: "src/report.ts", source: reportSource },
      { filePath: "src/page.ts", source: pageSource },
    ];
    const fn = candidate(reportSource, "src/report.ts", "renderReport");
    if (!fn) return;

    const evidence = buildVariantPartitionedHelperEvidence(fn, files);

    expect(evidence).toMatchObject({
      function: { name: "renderReport", filePath: "src/report.ts" },
      discriminant: {
        name: "format",
        placement: "positional",
        values: expect.arrayContaining(["json", "csv"]),
      },
      armOverlap: { disjoint: true },
      callerGroups: expect.arrayContaining([
        expect.objectContaining({ value: "json", count: 1 }),
        expect.objectContaining({ value: "csv", count: 1 }),
      ]),
      mixedCallers: 1,
    });
    expect(evidence?.arms).toHaveLength(2);
    expect(evidence?.arms.every(({ value }) => value === "json" || value === "csv")).toBe(true);
  });

  it("reads an options-bag discriminant field and its literal call sites", () => {
    const files: ProjectFile[] = [
      { filePath: "src/bag.ts", source: bagSource },
      { filePath: "src/bag-page.ts", source: bagCaller },
    ];
    const fn = candidate(bagSource, "src/bag.ts", "renderBag");
    if (!fn) return;

    const evidence = buildVariantPartitionedHelperEvidence(fn, files);

    expect(evidence).toMatchObject({
      discriminant: {
        name: "format",
        placement: "options-bag",
        values: expect.arrayContaining(["json", "csv"]),
      },
      mixedCallers: 0,
    });
    expect(evidence?.callerGroups).toHaveLength(2);
  });

  it("abstains when the only discriminant is a boolean flag", () => {
    const source = `export function renderUser(name: string, detailed: boolean): string {
      if (detailed) {
        return "detail " + name;
      }
      return name;
    }
    `;
    const fn = candidate(source, "src/report.ts", "renderUser");
    if (!fn) return;

    expect(
      buildVariantPartitionedHelperEvidence(fn, [{ filePath: "src/report.ts", source }]),
    ).toBeUndefined();
  });

  it("abstains when no parameter feeds a variant branch", () => {
    const source = `export function greet(name: string): string {
      return "hello " + name;
    }
    `;
    const fn = candidate(source, "src/greet.ts", "greet");
    if (!fn) return;

    expect(
      buildVariantPartitionedHelperEvidence(fn, [{ filePath: "src/greet.ts", source }]),
    ).toBeUndefined();
  });
});
