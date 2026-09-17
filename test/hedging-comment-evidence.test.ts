import { describe, expect, it } from "vitest";
import { defaultConfig } from "../src/config.js";
import { extractCandidates } from "../src/candidates.js";
import { buildRuleEvidence } from "../src/evidence/index.js";

describe("hedging comment wiring", () => {
  it("ships as a comment judgment without thresholds", () => {
    expect(defaultConfig.rules["jev/no-hedging-comment"]).toMatchObject({
      scope: "comment",
      message: expect.any(String),
    });
    expect(defaultConfig.rules["jev/no-hedging-comment"]).not.toHaveProperty("threshold");
    expect(defaultConfig.rules["jev/no-hedging-comment"]).not.toHaveProperty("severity");
  });

  it("passes comment candidates through with candidate source like narrating-comment", () => {
    const source = `// should handle most cases
export function parse(input: string): string {
  return input.trim();
}
`;
    const candidate = extractCandidates("src/parse.ts", source)
      .find(({ kind }) => kind === "comment");
    expect(candidate).toBeDefined();
    if (!candidate) return;
    expect(candidate.source).toContain("should handle most cases");

    expect(buildRuleEvidence(
      "jev/no-hedging-comment",
      candidate,
      [{ filePath: "src/parse.ts", source }],
    )).toEqual({ handled: false });
  });
});
