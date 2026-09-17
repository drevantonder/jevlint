import { describe, expect, it } from "vitest";
import { parseChangedLineRanges } from "../src/changed-lines.js";

describe("parseChangedLineRanges", () => {
  it("reads added and replaced line ranges from a zero-context Git diff", () => {
    const diff = [
      "@@ -2 +2,2 @@",
      "-old",
      "+new",
      "+newer",
      "@@ -10,2 +11,0 @@",
      "-gone",
      "-also gone",
      "@@ -20 +19 @@",
      "-before",
      "+after",
    ].join("\n");

    expect(parseChangedLineRanges(diff)).toEqual([
      { start: 2, end: 3 },
      { start: 19, end: 19 },
    ]);
  });
});
