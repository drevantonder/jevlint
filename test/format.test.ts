import { describe, expect, it } from "vitest";
import { createReviewReport, formatJson, formatText } from "../src/format.js";
import type { Judgment } from "../src/types.js";

function judgment(
  ruleId: string,
  probability: number,
  filePath: string,
  line: number,
): Judgment {
  return {
    ruleId,
    message: `${ruleId} proposition`,
    probability,
    filePath,
    span: {
      start: { line, column: 1 },
      end: { line: line + 1, column: 2 },
    },
    candidateKind: "function",
    evidence: { coverage: { callers: 2 } },
  };
}

const judgments = [
  judgment("test/low", 0.2, "src/z.ts", 8),
  judgment("test/tie-b", 0.8, "src/b.ts", 4),
  judgment("test/high", 0.95, "src/z.ts", 2),
  judgment("test/tie-a", 0.8, "src/a.ts", 6),
];

describe("review report formatting", () => {
  it("ranks scores descending with deterministic location tie-breaks", () => {
    const report = createReviewReport({
      judgments,
      abstentions: [],
      failures: [],
      statistics: { requests: 1, questions: 4 },
    });

    expect(report.judgments.map(({ ruleId }) => ruleId)).toEqual([
      "test/high",
      "test/tie-a",
      "test/tie-b",
      "test/low",
    ]);
    expect(formatText(report)).toContain(
      "0.950  src/z.ts:2:1-3:2  function  test/high  test/high proposition",
    );
    expect(formatText(report)).toContain(
      "4 evaluated; 4 displayed; 0 structurally abstained; 0 failed",
    );
  });

  it("applies score and count filters only to display counts", () => {
    const report = createReviewReport({
      judgments,
      abstentions: [{ ruleId: "test/gated", candidateKind: "function", count: 3 }],
      failures: [],
      statistics: { requests: 1, questions: 4 },
      display: { minScore: 0.5, limit: 2 },
    });

    expect(report.summary).toEqual({
      evaluated: 4,
      displayed: 2,
      abstained: 3,
      failed: 0,
      complete: true,
    });
    expect(report.judgments.map(({ ruleId }) => ruleId)).toEqual(["test/high", "test/tie-a"]);
  });

  it("emits a versioned JSON object with evidence, failures, and request statistics", () => {
    const report = createReviewReport({
      judgments: [judgments[0]!],
      abstentions: [{ ruleId: "test/gated", candidateKind: "function", count: 2 }],
      failures: [{
        filePath: "src/fail.ts",
        candidateIds: ["candidate_1"],
        ruleIds: ["test/fail"],
        questionCount: 1,
        message: "service unavailable",
      }],
      statistics: { requests: 2, questions: 2 },
      cacheStatistics: {
        hits: 1,
        misses: 1,
        writes: 1,
        recoveries: 0,
        errors: 0,
        liveRequests: 1,
      },
    });

    expect(JSON.parse(formatJson(report))).toEqual({
      version: 1,
      summary: {
        evaluated: 1,
        displayed: 1,
        abstained: 2,
        failed: 1,
        complete: false,
      },
      judgments: [judgments[0]],
      abstentions: [{ ruleId: "test/gated", candidateKind: "function", count: 2 }],
      failures: {
        total: 1,
        omitted: 0,
        items: [expect.objectContaining({ ruleIds: ["test/fail"] })],
      },
      statistics: {
        evaluation: { requests: 2, questions: 2 },
        cache: {
          hits: 1,
          misses: 1,
          writes: 1,
          recoveries: 0,
          errors: 0,
          liveRequests: 1,
        },
      },
    });
  });
});
