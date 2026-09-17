#!/usr/bin/env node

import { pathToFileURL } from "node:url";
import {
  analyzeChangesWithFailures,
  analyzeFileWithFailures,
} from "./analyze.js";
import { CachedEvaluator } from "./cache.js";
import type { CacheMode } from "./cache.js";
import { loadConfig } from "./config.js";
import {
  createReviewReport,
  formatJson,
  formatText,
  MAX_REPORTED_FAILURES,
} from "./format.js";
import type { CreateReviewReportInput, DisplayOptions } from "./format.js";
import { collectChangedFiles, collectRepositoryFiles, repositoryCacheContext } from "./git.js";
import { TypeSafeEvaluator } from "./typesafe-evaluator.js";
import type {
  EvaluationFailure,
  EvaluationStatistics,
  Evaluator,
  Judgment,
  StructuralAbstentionCount,
} from "./types.js";

const USAGE = `Usage: jevlint review [options]

Commands:
  review            Review changed code and report probability scores
  diff              Compatibility alias for review

Options:
  --staged           Review staged changes
  --format <format>  Output text or json
  --config <path>    Use a specific config file
  --min-score <n>    Display scores at or above n (0 to 1)
  --limit <n>        Display at most n judgments
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
  staged: boolean;
  format: "text" | "json";
  configPath?: string;
  minScore: number;
  limit?: number;
  cacheMode: CacheMode;
  verbose: boolean;
  help: boolean;
}

function score(value: string): number | undefined {
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed >= 0 && parsed <= 1 ? parsed : undefined;
}

function limit(value: string): number | undefined {
  const parsed = Number(value);
  return Number.isSafeInteger(parsed) && parsed >= 0 ? parsed : undefined;
}

function parseArgs(args: string[]): CliOptions | undefined {
  if (args[0] !== "review" && args[0] !== "diff") return undefined;

  const options: CliOptions = {
    staged: false,
    format: "text",
    minScore: 0,
    cacheMode: "read-write",
    verbose: false,
    help: false,
  };
  let cacheModeSet = false;
  for (let index = 1; index < args.length; index += 1) {
    const argument = args[index];
    if (argument === "--staged") options.staged = true;
    else if (argument === "--help") options.help = true;
    else if (argument === "--verbose") options.verbose = true;
    else if (argument === "--no-cache" || argument === "--refresh-cache") {
      if (cacheModeSet) return undefined;
      options.cacheMode = argument === "--no-cache" ? "disabled" : "refresh";
      cacheModeSet = true;
    } else if (
      argument === "--format"
      || argument === "--config"
      || argument === "--min-score"
      || argument === "--limit"
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
    const configPromise = options.configPath === undefined
      ? loadConfig({ cwd })
      : loadConfig({ cwd, configPath: options.configPath });
    const [config, files, projectFiles] = await Promise.all([
      configPromise,
      collectChangedFiles({ cwd, staged: options.staged }),
      collectRepositoryFiles({ cwd, staged: options.staged }),
    ]);
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

    const reportInput: CreateReviewReportInput = {
      judgments,
      abstentions,
      failures,
      statistics,
    };
    if (cachedEvaluator !== undefined) reportInput.cacheStatistics = cachedEvaluator.statistics;
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
      } else {
        stderr("jevlint cache: disabled\n");
      }
    }
    return failures.length > 0 ? 2 : 0;
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
