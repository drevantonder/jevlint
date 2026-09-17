import { sortAbstentions, sortJudgments } from "./analyze.js";
import type { CacheStatistics } from "./cache.js";
import type {
  DisplayOptions,
  EvaluationFailure,
  EvaluationStatistics,
  Judgment,
  ReviewReport,
  StructuralAbstentionCount,
} from "./types.js";

export const MAX_REPORTED_FAILURES = 20;

export interface CreateReviewReportInput {
  judgments: Judgment[];
  abstentions: StructuralAbstentionCount[];
  failures: EvaluationFailure[];
  statistics: EvaluationStatistics;
  cacheStatistics?: CacheStatistics;
  display?: DisplayOptions;
}

export function createReviewReport(input: CreateReviewReportInput): ReviewReport {
  const judgments = sortJudgments(input.judgments);
  const minScore = input.display?.minScore ?? 0;
  const matching = judgments.filter(({ probability }) => probability >= minScore);
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
  const display: DisplayOptions = { minScore };
  if (input.display?.limit !== undefined) display.limit = input.display.limit;

  return {
    version: 1,
    summary: {
      evaluated: judgments.length,
      displayed: displayed.length,
      abstained: abstentions.reduce((total, abstention) => total + abstention.count, 0),
      failed,
      complete: failed === 0,
    },
    judgments,
    display,
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

function visibleJudgments(report: ReviewReport): Judgment[] {
  const minScore = report.display.minScore ?? 0;
  const matching = report.judgments.filter(({ probability }) => probability >= minScore);
  return report.display.limit === undefined
    ? matching
    : matching.slice(0, report.display.limit);
}

export function formatText(report: ReviewReport): string {
  const judgments = visibleJudgments(report).map((judgment) =>
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
