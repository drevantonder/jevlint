import { readFile } from "node:fs/promises";
import { describe, expect, it } from "vitest";
import {
  extractCandidates,
  filterCandidatesByChangedLines,
} from "../src/candidates.js";

const fixtureUrl = new URL("./fixtures/sloppy.ts", import.meta.url);

describe("extractCandidates", () => {
  it("uses Oxc spans to locate functions and comments", async () => {
    const source = await readFile(fixtureUrl, "utf8");

    const candidates = extractCandidates("src/sloppy.ts", source);

    expect(candidates.map(({ kind, startLine, endLine }) => ({ kind, startLine, endLine })))
      .toEqual([
        { kind: "comment", startLine: 3, endLine: 3 },
        { kind: "function", startLine: 4, endLine: 6 },
        { kind: "function", startLine: 8, endLine: 11 },
      ]);
    expect(candidates[1]?.source).toContain("function normalizeUser");
  });

  it("keeps only candidates touched by changed lines", async () => {
    const source = await readFile(fixtureUrl, "utf8");
    const candidates = extractCandidates("src/sloppy.ts", source);

    const changed = filterCandidatesByChangedLines(candidates, [
      { start: 5, end: 5 },
    ]);

    expect(changed).toHaveLength(1);
    expect(changed[0]?.source).toContain("normalizeUser");
  });
});
