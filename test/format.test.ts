import { describe, expect, it } from "vitest";
import { createReviewReport, formatJson, formatText } from "../src/format.js";
import type { Judgment, ReviewReport } from "../src/types.js";

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
  const topFiveJudgments = [
    judgment("test/first", 0.9, "src/f1.ts", 1),
    judgment("test/second", 0.8, "src/f2.ts", 2),
    judgment("test/third", 0.7, "src/f3.ts", 3),
    judgment("test/fourth", 0.6, "src/f4.ts", 4),
    judgment("test/fifth", 0.5, "src/f5.ts", 5),
    judgment("test/sixth", 0.4, "src/f6.ts", 6),
    judgment("test/seventh", 0.3, "src/f7.ts", 7),
  ];

  function scoreLines(text: string): string[] {
    return text.split("\n").filter((line) => /^\d\.\d{3}  /.test(line));
  }

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

  it("keeps every judgment in the report and filters only text display", () => {
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
    expect(report.display).toEqual({ minScore: 0.5, limit: 2 });
    expect(report.judgments.map(({ ruleId }) => ruleId)).toEqual([
      "test/high",
      "test/tie-a",
      "test/tie-b",
      "test/low",
    ]);
    const text = formatText(report);
    expect(text).toContain(
      "0.950  src/z.ts:2:1-3:2  function  test/high  test/high proposition",
    );
    expect(text).toContain(
      "0.800  src/a.ts:6:1-7:2  function  test/tie-a  test/tie-a proposition",
    );
    expect(text).not.toContain("0.200");
    expect(text).not.toContain("test/tie-b");
    expect(text).toContain("4 evaluated; 2 displayed; 3 structurally abstained; 0 failed");
    expect(text).toContain(
      "1 more judgments hidden; raise --limit, filter with --min-score, or use --format json for the full report.",
    );
    expect(JSON.parse(formatJson(report)).judgments).toHaveLength(4);
  });

  it("defaults text display to the top five judgments with a hidden-count hint", () => {
    const report = createReviewReport({
      judgments: topFiveJudgments,
      abstentions: [],
      failures: [],
      statistics: { requests: 1, questions: 7 },
    });

    expect(report.display).toEqual({ minScore: 0, limit: 5 });
    expect(report.summary.displayed).toBe(5);
    expect(report.judgments).toHaveLength(7);
    const text = formatText(report);
    expect(scoreLines(text)).toHaveLength(5);
    expect(text).toContain("test/first");
    expect(text).toContain("test/fifth");
    expect(text).not.toContain("test/sixth");
    expect(text).not.toContain("test/seventh");
    expect(text).toContain("7 evaluated; 5 displayed; 0 structurally abstained; 0 failed");
    expect(text.trimEnd().endsWith(
      "2 more judgments hidden; raise --limit, filter with --min-score, or use --format json for the full report.",
    )).toBe(true);
  });

  it("honors an explicit limit over the default and counts the remainder", () => {
    const report = createReviewReport({
      judgments: topFiveJudgments,
      abstentions: [],
      failures: [],
      statistics: { requests: 1, questions: 7 },
      display: { limit: 2 },
    });

    expect(report.display).toEqual({ minScore: 0, limit: 2 });
    expect(report.summary.displayed).toBe(2);
    const text = formatText(report);
    expect(scoreLines(text)).toHaveLength(2);
    expect(text).toContain(
      "5 more judgments hidden; raise --limit, filter with --min-score, or use --format json for the full report.",
    );
  });

  it("keeps the summary when the limit is zero", () => {
    const report = createReviewReport({
      judgments: topFiveJudgments,
      abstentions: [],
      failures: [],
      statistics: { requests: 1, questions: 7 },
      display: { limit: 0 },
    });

    expect(report.summary.displayed).toBe(0);
    const text = formatText(report);
    expect(scoreLines(text)).toHaveLength(0);
    expect(text).toContain("7 evaluated; 0 displayed; 0 structurally abstained; 0 failed");
    expect(text).toContain(
      "7 more judgments hidden; raise --limit, filter with --min-score, or use --format json for the full report.",
    );
  });

  it("omits the hint line when nothing is hidden", () => {
    const report = createReviewReport({
      judgments,
      abstentions: [],
      failures: [],
      statistics: { requests: 1, questions: 4 },
    });

    expect(report.display).toEqual({ minScore: 0, limit: 5 });
    expect(report.summary.displayed).toBe(4);
    const text = formatText(report);
    expect(scoreLines(text)).toHaveLength(4);
    expect(text).toContain("4 evaluated; 4 displayed; 0 structurally abstained; 0 failed");
    expect(text).not.toContain("more judgments hidden");
    expect(text.trimEnd().endsWith(
      "4 evaluated; 4 displayed; 0 structurally abstained; 0 failed",
    )).toBe(true);
  });

  it("applies min-score before the limit and counts only limit-hidden judgments", () => {
    const report = createReviewReport({
      judgments: topFiveJudgments,
      abstentions: [],
      failures: [],
      statistics: { requests: 1, questions: 7 },
      display: { minScore: 0.45, limit: 2 },
    });

    expect(report.summary.displayed).toBe(2);
    const text = formatText(report);
    expect(scoreLines(text)).toHaveLength(2);
    expect(text).toContain("test/first");
    expect(text).toContain("test/second");
    expect(text).not.toContain("test/sixth");
    expect(text).toContain("7 evaluated; 2 displayed; 0 structurally abstained; 0 failed");
    expect(text).toContain(
      "3 more judgments hidden; raise --limit, filter with --min-score, or use --format json for the full report.",
    );
  });

  it("keeps JSON complete and consistent with the text summary under the default limit", () => {
    const report = createReviewReport({
      judgments: topFiveJudgments,
      abstentions: [],
      failures: [],
      statistics: { requests: 1, questions: 7 },
    });
    // SAFETY: formatJson serializes the report object produced by createReviewReport.
    const parsed = JSON.parse(formatJson(report)) as ReviewReport;

    expect(parsed.judgments).toHaveLength(7);
    expect(parsed.summary.evaluated).toBe(7);
    expect(parsed.summary.displayed).toBe(5);
    expect(parsed.display).toEqual({ minScore: 0, limit: 5 });
    const textRows = scoreLines(formatText(report)).length;
    expect(textRows).toBe(parsed.summary.displayed);
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
      display: { minScore: 0, limit: 5 },
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
