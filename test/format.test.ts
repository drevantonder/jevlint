import { describe, expect, it } from "vitest";
import { formatJson, formatText } from "../src/format.js";
import type { Diagnostic } from "../src/types.js";

const diagnostic: Diagnostic = {
  filePath: "src/auth.ts",
  line: 2,
  column: 1,
  endLine: 4,
  endColumn: 2,
  severity: "warning",
  ruleId: "jev/no-pass-through-wrapper",
  message: "Pass-through wrapper adds no meaningful behavior.",
  probability: 0.913,
};

describe("diagnostic formatting", () => {
  it("formats concise text output", () => {
    expect(formatText([diagnostic])).toBe(
      "src/auth.ts:2:1  warning  Pass-through wrapper adds no meaningful behavior.  jev/no-pass-through-wrapper (0.91)",
    );
  });

  it("formats machine-readable JSON", () => {
    expect(JSON.parse(formatJson([diagnostic]))).toEqual([diagnostic]);
  });
});
