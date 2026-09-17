import { sortAbstentions, sortJudgments } from "./analyze.js";
import type { CacheStatistics } from "./cache.js";
import type {
  AuditCoverage,
  DisplayOptions,
  EvaluationFailure,
  EvaluationStatistics,
  Judgment,
  ReviewReport,
  StructuralAbstentionCount,
} from "./types.js";

export const MAX_REPORTED_FAILURES = 20;

export const DEFAULT_DISPLAY_LIMIT = 5;

export interface CreateReviewReportInput {
  judgments: Judgment[];
  abstentions: StructuralAbstentionCount[];
  failures: EvaluationFailure[];
  statistics: EvaluationStatistics;
  cacheStatistics?: CacheStatistics;
  display?: DisplayOptions;
  coverage?: AuditCoverage;
}

export function createReviewReport(input: CreateReviewReportInput): ReviewReport {
  const judgments = sortJudgments(input.judgments);
  const minScore = input.display?.minScore ?? 0;
  const matching = judgments.filter(({ probability }) => probability >= minScore);
  const limit = input.display?.limit ?? DEFAULT_DISPLAY_LIMIT;
  const displayed = matching.slice(0, limit);
  const abstentions = sortAbstentions(input.abstentions);
  const failed = input.failures.reduce((total, failure) => total + failure.questionCount, 0);
  const failureItems = input.failures.slice(0, MAX_REPORTED_FAILURES);
  const statistics: ReviewReport["statistics"] = {
    evaluation: { ...input.statistics },
  };
  if (input.cacheStatistics !== undefined) statistics.cache = { ...input.cacheStatistics };
  const display: DisplayOptions = { minScore, limit };

  const report: ReviewReport = {
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
  if (input.coverage !== undefined) report.coverage = input.coverage;
  return report;
}

function location(judgment: Judgment): string {
  const start = judgment.span.start;
  const end = judgment.span.end;
  return `${judgment.filePath}:${start.line}:${start.column}-${end.line}:${end.column}`;
}

export function formatCoverage(coverage: AuditCoverage): string {
  return `${coverage.filesScored} of ${coverage.filesEnumerated} files scored, `
    + `${coverage.filesOmitted} omitted; `
    + `${coverage.candidatesScored} of ${coverage.candidatesEnumerated} candidates scored; `
    + `${coverage.questionsPrepared} prepared, ${coverage.questionsAsked} asked; `
    + `${coverage.unscoredRules.length} rules unscored without change context; `
    + `coverage ${coverage.complete ? "complete" : "incomplete"}`;
}

export function formatText(report: ReviewReport): string {
  const minScore = report.display.minScore ?? 0;
  const matching = report.judgments.filter(({ probability }) => probability >= minScore);
  const rows = matching
    .slice(0, report.display.limit ?? DEFAULT_DISPLAY_LIMIT)
    .map((judgment) =>
      `${judgment.probability.toFixed(3)}  ${location(judgment)}  `
      + `${judgment.candidateKind}  ${judgment.ruleId}  ${judgment.message}`
    );
  const summary = `${report.summary.evaluated} evaluated; ${report.summary.displayed} displayed; `
    + `${report.summary.abstained} structurally abstained; ${report.summary.failed} failed`
    + (report.coverage !== undefined ? `; ${formatCoverage(report.coverage)}` : "");
  const hidden = matching.length - rows.length;
  const hint = hidden > 0
    ? `\n${hidden} more judgments hidden; raise --limit, filter with --min-score, or use --format json for the full report.`
    : "";
  return rows.length === 0 ? `${summary}${hint}` : `${rows.join("\n")}\n\n${summary}${hint}`;
}

export function formatJson(report: ReviewReport): string {
  return JSON.stringify(report, null, 2);
}

function escapeAnnotationData(text: string): string {
  return text.replaceAll("%", "%25").replaceAll("\r", "%0D").replaceAll("\n", "%0A");
}

function escapeAnnotationProperty(text: string): string {
  return escapeAnnotationData(text).replaceAll(",", "%2C").replaceAll(":", "%3A");
}

export function formatGithub(report: ReviewReport): string {
  return report.judgments.map((judgment) => {
    const start = judgment.span.start;
    const end = judgment.span.end;
    const properties = `file=${escapeAnnotationProperty(judgment.filePath)}`
      + `,line=${start.line},col=${start.column},endLine=${end.line},endColumn=${end.column}`;
    const message = escapeAnnotationData(
      `${judgment.probability.toFixed(3)} ${judgment.ruleId} ${judgment.message}`,
    );
    return `::notice ${properties}::${message}`;
  }).join("\n");
}
