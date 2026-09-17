import { describe, expect, it } from "vitest";
import { extractCandidates } from "../src/candidates.js";
import { buildTruncatingNumericParseEvidence } from "../src/evidence/truncating-numeric-parse.js";

function candidateFor(source: string, marker: string) {
  const candidate = extractCandidates("src/page.ts", source)
    .find(({ source: text }) => text.includes(marker));
  expect(candidate).toBeDefined();
  if (!candidate) throw new Error("fixture candidate missing");
  return candidate;
}

const RADIXLESS = `export function pageFromQuery(query: Record<string, string>) {
  const page = parseInt(query.page);
  return page * 20;
}`;

const GUARDED = `export function pageFromQuery(query: Record<string, string>) {
  const page = parseInt(query.page, 10);
  if (Number.isNaN(page) || page < 1) throw new Error("bad page");
  return page * 20;
}`;

const NO_PARSE = `export function double(value: number) {
  return value * 2;
}`;

describe("truncating numeric parse evidence", () => {
  it("flags radixless parseInt on request input without guards", () => {
    const candidate = candidateFor(RADIXLESS, "pageFromQuery");
    const evidence = buildTruncatingNumericParseEvidence(candidate, [
      { filePath: "src/page.ts", source: RADIXLESS },
    ]);
    expect(evidence).toMatchObject({
      function: { name: "pageFromQuery", exported: true },
      usesRadixlessParseInt: true,
      hasNaNGuard: false,
      hasExternalInput: true,
    });
    expect(evidence?.parses.length).toBeGreaterThan(0);
  });

  it("records NaN and range guards beside the parse", () => {
    const candidate = candidateFor(GUARDED, "pageFromQuery");
    const evidence = buildTruncatingNumericParseEvidence(candidate, [
      { filePath: "src/page.ts", source: GUARDED },
    ]);
    expect(evidence).toMatchObject({
      usesRadixlessParseInt: false,
      hasNaNGuard: true,
      hasRangeCheck: true,
    });
  });

  it("abstains when nothing is parsed", () => {
    const candidate = candidateFor(NO_PARSE, "double");
    expect(buildTruncatingNumericParseEvidence(candidate, [
      { filePath: "src/page.ts", source: NO_PARSE },
    ])).toBeUndefined();
  });
});
