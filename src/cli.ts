#!/usr/bin/env node

import { pathToFileURL } from "node:url";
import {
  analyzeAuditWithFailures,
  analyzeChangesWithFailures,
  analyzeFileWithFailures,
  analyzeModulesWithFailures,
} from "./analyze.js";
import type { AnalyzeAuditInput } from "./analyze.js";
import { CachedEvaluator } from "./cache.js";
import type { CacheMode } from "./cache.js";
import { loadConfig } from "./config.js";
import {
  createReviewReport,
  formatJson,
  formatText,
  MAX_REPORTED_FAILURES,
} from "./format.js";
import type { CreateReviewReportInput } from "./format.js";
import type { DisplayOptions } from "./types.js";
import { collectChangedFiles, collectRepositoryFiles, repositoryCacheContext } from "./git.js";
import { TypeSafeEvaluator } from "./typesafe-evaluator.js";
import type {
  AuditCoverage,
  EvaluationFailure,
  EvaluationStatistics,
  Evaluator,
  Judgment,
  StructuralAbstentionCount,
} from "./types.js";

const USAGE = `Usage: jevlint <command> [options]

Commands:
  review            Review changed code (the diff) and report probability scores
  diff              Compatibility alias for review
  audit             Survey the whole codebase (every source file) and report probability scores

  review scores changed code only: the working-tree or staged diff against
  HEAD. On a clean tree there is nothing changed, so there is nothing to
  score. audit scores the whole codebase without needing a diff and runs
  to completion by default: every candidate/rule pair is prepared unless
  you opt into a limit below. Both commands report probabilities only: no
  pass/fail, no thresholds, no bands.

Options for review and diff:
  --staged           Review staged changes
Options for audit:
  --max-questions <n>       Stop preparing evaluation questions once n are
                            prepared; the rest are reported as omitted, in
                            deterministic priority order (never sampled, never
                            cut by score). Absent = full run.
  --evidence-budget-ms <n>  Wall-clock guard on question preparation;
                            remaining pairs are omitted on expiry.
                            Absent = unlimited.
  --dry-run                 Prepare and count questions without calling Jev;
                            reports coverage and cost with zero live requests
Shared options:
  --format <format>  Output text or json
  --config <path>    Use a specific config file
  --min-score <n>    Display scores at or above n (0 to 1)
  --limit <n>        Display at most n judgments (default 5)
  --no-cache         Bypass the local Jev response cache
  --refresh-cache    Re-evaluate and replace matching cache entries
  --verbose          Report cache hits, misses, and live requests
  --help             Show this help
`;

interface CliDependencies {
  cwd?: string;
  evaluator?: Evaluator;
  stdout?: (text: string) => void;
  stderr?: (text: string) => void;
}

interface CliOptions {
  command: "review" | "audit";
  staged: boolean;
  format: "text" | "json";
  configPath?: string;
  minScore: number;
  limit?: number;
  cacheMode: CacheMode;
  verbose: boolean;
  help: boolean;
  maxQuestions?: number;
  evidenceBudgetMs?: number;
  dryRun: boolean;
}

function score(value: string): number | undefined {
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed >= 0 && parsed <= 1 ? parsed : undefined;
}

function limit(value: string): number | undefined {
  const parsed = Number(value);
  return Number.isSafeInteger(parsed) && parsed >= 0 ? parsed : undefined;
}

function count(value: string, minimum: number): number | undefined {
  const parsed = Number(value);
  return Number.isSafeInteger(parsed) && parsed >= minimum ? parsed : undefined;
}

function parseArgs(args: string[]): CliOptions | undefined {
  const command = args[0];
  if (command !== "review" && command !== "diff" && command !== "audit") return undefined;

  const options: CliOptions = {
    command: command === "audit" ? "audit" : "review",
    staged: false,
    format: "text",
    minScore: 0,
    cacheMode: "read-write",
    verbose: false,
    help: false,
    dryRun: false,
  };
  let cacheModeSet = false;
  for (let index = 1; index < args.length; index += 1) {
    const argument = args[index];
    if (argument === "--staged") {
      if (options.command === "audit") return undefined;
      options.staged = true;
    } else if (argument === "--help") options.help = true;
    else if (argument === "--verbose") options.verbose = true;
    else if (argument === "--dry-run") {
      if (options.command !== "audit") return undefined;
      options.dryRun = true;
    } else if (argument === "--no-cache" || argument === "--refresh-cache") {
      if (cacheModeSet) return undefined;
      options.cacheMode = argument === "--no-cache" ? "disabled" : "refresh";
      cacheModeSet = true;
    } else if (
      argument === "--format"
      || argument === "--config"
      || argument === "--min-score"
      || argument === "--limit"
      || argument === "--max-questions"
      || argument === "--evidence-budget-ms"
    ) {
      const value = args[index + 1];
      if (!value) return undefined;
      index += 1;
      if (argument === "--format") {
        if (value !== "text" && value !== "json") return undefined;
        options.format = value;
      } else if (argument === "--config") {
        options.configPath = value;
      } else if (argument === "--min-score") {
        const parsed = score(value);
        if (parsed === undefined) return undefined;
        options.minScore = parsed;
      } else if (argument === "--max-questions") {
        if (options.command !== "audit") return undefined;
        const parsed = count(value, 1);
        if (parsed === undefined) return undefined;
        options.maxQuestions = parsed;
      } else if (argument === "--evidence-budget-ms") {
        if (options.command !== "audit") return undefined;
        const parsed = count(value, 0);
        if (parsed === undefined) return undefined;
        options.evidenceBudgetMs = parsed;
      } else {
        const parsed = limit(value);
        if (parsed === undefined) return undefined;
        options.limit = parsed;
      }
    } else {
      return undefined;
    }
  }
  return options;
}

function addStatistics(target: EvaluationStatistics, source: EvaluationStatistics): void {
  target.requests += source.requests;
  target.questions += source.questions;
}

interface FinishedRun {
  judgments: Judgment[];
  abstentions: StructuralAbstentionCount[];
  failures: EvaluationFailure[];
  statistics: EvaluationStatistics;
  cachedEvaluator: CachedEvaluator | undefined;
  coverage: AuditCoverage | undefined;
}

function finishRun(
  run: FinishedRun,
  options: CliOptions,
  stdout: (text: string) => void,
  stderr: (text: string) => void,
): number {
  const { judgments, abstentions, failures, statistics, cachedEvaluator, coverage } = run;
  const reportInput: CreateReviewReportInput = {
    judgments,
    abstentions,
    failures,
    statistics,
  };
  if (cachedEvaluator !== undefined) reportInput.cacheStatistics = cachedEvaluator.statistics;
  if (coverage !== undefined) reportInput.coverage = coverage;
  const display: DisplayOptions = { minScore: options.minScore };
  if (options.limit !== undefined) display.limit = options.limit;
  reportInput.display = display;
  const report = createReviewReport(reportInput);
  const output = options.format === "json" ? formatJson(report) : formatText(report);
  stdout(`${output}\n`);

  for (const failure of failures.slice(0, MAX_REPORTED_FAILURES)) {
    stderr(
      `jevlint: ${failure.filePath}: ${failure.questionCount} evaluation question${failure.questionCount === 1 ? "" : "s"} failed (${failure.ruleIds.join(", ")}): ${failure.message}\n`,
    );
  }
  if (failures.length > MAX_REPORTED_FAILURES) {
    stderr(`jevlint: ${failures.length - MAX_REPORTED_FAILURES} additional evaluation failures omitted.\n`);
  }
  if (options.verbose) {
    if (cachedEvaluator) {
      const stats = cachedEvaluator.statistics;
      stderr(
        `jevlint cache: ${stats.hits} hits, ${stats.misses} misses, ${stats.liveRequests} live requests, ${stats.recoveries} recovered, ${stats.errors} errors\n`,
      );
    } else if (options.command === "audit" && options.dryRun) {
      stderr("jevlint cache: dry run (no requests)\n");
    } else {
      stderr("jevlint cache: disabled\n");
    }
  }
  return failures.length > 0 ? 2 : 0;
}

const dryRunEvaluator: Evaluator = {
  async evaluate(): Promise<Record<string, number>> {
    throw new Error("dry run prepares questions without calling the evaluator");
  },
};

async function resolveEvaluator(
  cwd: string,
  options: CliOptions,
  dependencies: CliDependencies,
): Promise<{ evaluator: Evaluator; cachedEvaluator: CachedEvaluator | undefined }> {
  let cachedEvaluator: CachedEvaluator | undefined;
  let evaluator = dependencies.evaluator;
  if (evaluator instanceof CachedEvaluator) cachedEvaluator = evaluator;
  if (!evaluator) {
    const liveEvaluator = new TypeSafeEvaluator();
    if (options.cacheMode === "disabled") {
      evaluator = liveEvaluator;
    } else {
      const cacheContext = await repositoryCacheContext(cwd);
      cachedEvaluator = new CachedEvaluator(liveEvaluator, {
        ...cacheContext,
        identity: liveEvaluator.identity,
        mode: options.cacheMode,
      });
      evaluator = cachedEvaluator;
    }
  }
  return { evaluator, cachedEvaluator };
}

async function runAudit(
  cwd: string,
  options: CliOptions,
  dependencies: CliDependencies,
  stdout: (text: string) => void,
  stderr: (text: string) => void,
): Promise<number> {
  const configPromise = options.configPath === undefined
    ? loadConfig({ cwd })
    : loadConfig({ cwd, configPath: options.configPath });
  const [config, projectFiles] = await Promise.all([
    configPromise,
    collectRepositoryFiles({ cwd, staged: false }),
  ]);
  let cachedEvaluator: CachedEvaluator | undefined;
  let evaluator: Evaluator = dryRunEvaluator;
  if (!options.dryRun) {
    const resolved = await resolveEvaluator(cwd, options, dependencies);
    evaluator = resolved.evaluator;
    cachedEvaluator = resolved.cachedEvaluator;
  } else if (dependencies.evaluator) {
    evaluator = dependencies.evaluator;
  }
  const auditInput: AnalyzeAuditInput = {
    projectFiles,
    config,
    dryRun: options.dryRun,
  };
  if (options.maxQuestions !== undefined) {
    auditInput.maxQuestions = options.maxQuestions;
  }
  if (options.evidenceBudgetMs !== undefined) {
    auditInput.evidenceBudgetMs = options.evidenceBudgetMs;
  }
  const result = await analyzeAuditWithFailures(auditInput, evaluator);
  return finishRun(
    {
      judgments: result.judgments,
      abstentions: result.abstentions,
      failures: result.failures,
      statistics: result.statistics,
      cachedEvaluator,
      coverage: result.coverage,
    },
    options,
    stdout,
    stderr,
  );
}

export async function runCli(args: string[], dependencies: CliDependencies = {}): Promise<number> {
  const stdout = dependencies.stdout ?? ((text: string) => process.stdout.write(text));
  const stderr = dependencies.stderr ?? ((text: string) => process.stderr.write(text));
  const options = parseArgs(args);

  if (!options) {
    stderr(USAGE);
    return 2;
  }
  if (options.help) {
    stdout(USAGE);
    return 0;
  }

  const cwd = dependencies.cwd ?? process.cwd();
  try {
    if (options.command === "audit") {
      return await runAudit(cwd, options, dependencies, stdout, stderr);
    }
    const configPromise = options.configPath === undefined
      ? loadConfig({ cwd })
      : loadConfig({ cwd, configPath: options.configPath });
    const [config, files, projectFiles] = await Promise.all([
      configPromise,
      collectChangedFiles({ cwd, staged: options.staged }),
      collectRepositoryFiles({ cwd, staged: options.staged }),
    ]);
    const { evaluator, cachedEvaluator } = await resolveEvaluator(cwd, options, dependencies);
    const judgments: Judgment[] = [];
    const abstentions: StructuralAbstentionCount[] = [];
    const failures: EvaluationFailure[] = [];
    const statistics: EvaluationStatistics = { requests: 0, questions: 0 };

    for (const file of files) {
      const result = await analyzeFileWithFailures(
        {
          filePath: file.filePath,
          source: file.source,
          changedLines: file.changedLines,
          config,
          projectFiles,
        },
        evaluator,
      );
      judgments.push(...result.judgments);
      abstentions.push(...result.abstentions);
      failures.push(...result.failures);
      addStatistics(statistics, result.statistics);
    }
    const changeResult = await analyzeChangesWithFailures(
      { changes: files, config, projectFiles },
      evaluator,
    );
    judgments.push(...changeResult.judgments);
    abstentions.push(...changeResult.abstentions);
    failures.push(...changeResult.failures);
    addStatistics(statistics, changeResult.statistics);
    const moduleResult = await analyzeModulesWithFailures(
      { changes: files, config, projectFiles },
      evaluator,
    );
    judgments.push(...moduleResult.judgments);
    abstentions.push(...moduleResult.abstentions);
    failures.push(...moduleResult.failures);
    addStatistics(statistics, moduleResult.statistics);

    return finishRun(
      { judgments, abstentions, failures, statistics, cachedEvaluator, coverage: undefined },
      options,
      stdout,
      stderr,
    );
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    stderr(`jevlint: ${message}\n`);
    return 2;
  }
}

const invokedPath = process.argv[1];
if (invokedPath && import.meta.url === pathToFileURL(invokedPath).href) {
  process.exitCode = await runCli(process.argv.slice(2));
}
