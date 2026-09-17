import { sortAbstentions, sortJudgments } from "./analyze.js";
import type { CacheStatistics } from "./cache.js";
import type {
  EvaluationFailure,
  EvaluationStatistics,
  Judgment,
  ReviewReport,
  StructuralAbstentionCount,
} from "./types.js";

export const MAX_REPORTED_FAILURES = 20;

export interface DisplayOptions {
  minScore?: number;
  limit?: number;
}

export interface CreateReviewReportInput {
  judgments: Judgment[];
  abstentions: StructuralAbstentionCount[];
  failures: EvaluationFailure[];
  statistics: EvaluationStatistics;
  cacheStatistics?: CacheStatistics;
  display?: DisplayOptions;
}

export function createReviewReport(input: CreateReviewReportInput): ReviewReport {
  const allJudgments = sortJudgments(input.judgments);
  const minScore = input.display?.minScore ?? 0;
  const matching = allJudgments.filter(({ probability }) => probability >= minScore);
  const displayed = input.display?.limit === undefined
    ? matching
    : matching.slice(0, input.display.limit);
  const abstentions = sortAbstentions(input.abstentions);
  const failed = input.failures.reduce((total, failure) => total + failure.questionCount, 0);
  const failureItems = input.failures.slice(0, MAX_REPORTED_FAILURES);
  const statistics: ReviewReport["statistics"] = {
    evaluation: { ...input.statistics },
  };
  if (input.cacheStatistics !== undefined) statistics.cache = { ...input.cacheStatistics };

  return {
    version: 1,
    summary: {
      evaluated: allJudgments.length,
      displayed: displayed.length,
      abstained: abstentions.reduce((total, abstention) => total + abstention.count, 0),
      failed,
      complete: failed === 0,
    },
    judgments: displayed,
    abstentions,
    failures: {
      total: input.failures.length,
      omitted: input.failures.length - failureItems.length,
      items: failureItems,
    },
    statistics,
  };
}

function location(judgment: Judgment): string {
  const start = judgment.span.start;
  const end = judgment.span.end;
  return `${judgment.filePath}:${start.line}:${start.column}-${end.line}:${end.column}`;
}

export function formatText(report: ReviewReport): string {
  const judgments = report.judgments.map((judgment) =>
    `${judgment.probability.toFixed(3)}  ${location(judgment)}  `
    + `${judgment.candidateKind}  ${judgment.ruleId}  ${judgment.message}`
  );
  const summary = `${report.summary.evaluated} evaluated; ${report.summary.displayed} displayed; `
    + `${report.summary.abstained} structurally abstained; ${report.summary.failed} failed`;
  return judgments.length === 0 ? summary : `${judgments.join("\n")}\n\n${summary}`;
}

export function formatJson(report: ReviewReport): string {
  return JSON.stringify(report, null, 2);
}
