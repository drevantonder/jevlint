#!/usr/bin/env node

import { stat } from "node:fs/promises";
import { isAbsolute, relative, resolve, sep } from "node:path";
import { pathToFileURL } from "node:url";
import { z } from "zod";
import {
  analyzeAuditWithFailures,
  analyzeChangesWithFailures,
  analyzeFileWithFailures,
  analyzeModulesWithFailures,
} from "./analyze.js";
import type { AnalyzeAuditInput } from "./analyze.js";
import { CachedEvaluator } from "./cache.js";
import type { CacheMode } from "./cache.js";
import { defaultConfig, loadConfig } from "./config.js";
import {
  createReviewReport,
  formatGithub,
  formatJson,
  formatText,
  MAX_REPORTED_FAILURES,
} from "./format.js";
import type { CreateReviewReportInput } from "./format.js";
import {
  defaultAuthIO,
  promptForApiKey,
  readKeyFromStdin,
  removeStoredCredential,
  resolveCredential,
  resolveCredentialWithIO,
  storeCredential,
  storedBackendLabel,
  EMPTY_STDIN_MESSAGE,
  MISSING_CREDENTIAL_MESSAGE,
  SETUP_CANCELLED_MESSAGE,
  STORED_PREFIX,
  STORED_REMOVED_MESSAGE,
  SetupCancelledError,
} from "./auth.js";
import type {
  AuthIO,
  CredentialSource,
  PromptStdin,
  StderrWriter,
} from "./auth.js";
import { createFileArtifact, writeFileArtifact, writeSummaryArtifact } from "./out-dir.js";
import type { DisplayOptions } from "./types.js";
import { collectChangedFiles, collectRepositoryFiles, repositoryCacheContext } from "./git.js";
import { TypeSafeEvaluator } from "./typesafe-evaluator.js";
import type {
  AnalysisResult,
  AuditCoverage,
  EvaluationFailure,
  EvaluationRequest,
  EvaluationStatistics,
  Evaluator,
  Judgment,
  StructuralAbstentionCount,
} from "./types.js";
import type { NoulQuestion } from "@typesafe-ai/sdk";

type DebugMode = "files" | "timings" | "cache";

type HelpCommand = "general" | "review" | "audit" | "setup";

const OPTIONS_SHARED = `Shared options:
  --format <format>  Output text, json, or github (also -f)
  -f <format>        Alias for --format
  --out-dir <dir>    Write one JSON artifact per evaluated file as files
                     complete, plus summary.json with the full report
  --config <path>    Use a specific config file
  --min-score <n>    Display scores at or above n (0 to 1)
  --limit <n>        Display at most n judgments (default 5)
  --no-cache         Bypass the local Jev response cache
  --refresh-cache    Re-evaluate and replace matching cache entries
  --no-error-on-unmatched-pattern
                     Exit 0 with an empty report when PATH scope matches nothing
  --debug=<mode>     files, timings, cache (comma-separated)
  --token <value>    Use this Typesafe (Jev) API key for this run only; never stored
  --no-prompt        Fail with an error instead of asking for an API key
  --print-config     Print effective config as JSON and exit
  --rules            List bundled rule keys and exit
  --help             Show this help

--rules prints every bundled rule key, one per line (a JSON array with
--format json), and exits without evaluating. --format github prints one
workflow annotation per judgment (file with its line/column span and the
probability in the message); display filters do not apply to annotations.
--out-dir writes artifacts alongside the normal stdout report without
replacing it.
--debug=files prints the resolved scope file list to stderr and exits without
evaluating. --debug=timings prints a per-rule timing table to stderr after the
report. --debug=cache prints cache statistics to stderr. Stdout carries only
the report or config JSON.
`;

const USAGE_GENERAL = `Usage: jevlint [PATH]... [options]
       jevlint review [PATH]... [options]
       jevlint audit [PATH]... [options]

Commands:
  (none)            Audit the full tree; bare jevlint is audit with no subcommand
  review            Review changed code and report probability scores
  audit             Survey the whole codebase and report probability scores
  setup             Store your Typesafe (Jev) API key for future runs

  With no subcommand, jevlint audits the full tree, or the given files or
  directories when PATHs are given. review stays explicit for change-scoped
  runs (working tree, --staged, hooks). audit surveys the whole codebase
  without needing a diff and runs to completion by default: every
  candidate/rule pair is prepared unless you opt into a limit below.
  Bare, review, and audit all report probabilities only: no
  pass/fail, no thresholds, no bands. The first live run with no stored
  key asks for it on first use; jevlint setup stores it on demand.

Review defaults to changed files; audit defaults to the full tree. PATH filters
scope to files or directories. Unknown paths follow the unmatched-pattern rule:
an error unless --no-error-on-unmatched-pattern is given.

Options for review:
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
${OPTIONS_SHARED}`;

const USAGE_REVIEW = `Usage: jevlint review [PATH]... [options]

Review changed code and report probability scores. Defaults to changed files;
PATH filters scope to files or directories. Unknown paths follow the
unmatched-pattern rule: an error unless --no-error-on-unmatched-pattern
is given. See also bare jevlint and jevlint audit, which survey the whole
codebase.

Options:
  --staged           Review staged changes
${OPTIONS_SHARED}`;

const USAGE_AUDIT = `Usage: jevlint audit [PATH]... [options]

Survey the whole codebase and report probability scores. Runs to completion
by default; every candidate/rule pair is prepared unless you opt into a limit
below. Defaults to every source file; PATH filters scope to files or
directories. Unknown paths follow the unmatched-pattern rule: an error unless
--no-error-on-unmatched-pattern is given. The bare form jevlint [PATH]...
runs this command with no subcommand. See also jevlint review, which
scores changed code only.

Options:
  --max-questions <n>       Stop preparing evaluation questions once n are
                            prepared; the rest are reported as omitted, in
                            deterministic priority order (never sampled, never
                            cut by score). Absent = full run.
  --evidence-budget-ms <n>  Wall-clock guard on question preparation;
                            remaining pairs are omitted on expiry.
                            Absent = unlimited.
  --dry-run                 Prepare and count questions without calling Jev;
                            reports coverage and cost with zero live requests
${OPTIONS_SHARED}`;

export interface CliDependencies {
  cwd?: string;
  evaluator?: Evaluator;
  stdout?: (text: string) => void;
  stderr?: (text: string) => void;
  authIO?: AuthIO;
  stdin?: PromptStdin;
}

interface EnsureCredentialInput {
  tokenFlag: string | undefined;
  noPrompt: boolean;
  stdin: PromptStdin;
  stderr: StderrWriter;
  authIO: AuthIO | undefined;
}

interface LiveCredential {
  token: string;
  source: CredentialSource;
}

type CredentialOutcome =
  | { ok: true; credential: LiveCredential }
  | { ok: false; exitCode: number };

interface CliOptions {
  command: "review" | "audit" | "setup";
  paths: string[];
  staged: boolean;
  format: "text" | "json" | "github";
  outDir?: string;
  configPath?: string;
  minScore: number;
  limit?: number;
  cacheMode: CacheMode;
  noErrorOnUnmatchedPattern: boolean;
  debug: DebugMode[];
  printConfig: boolean;
  listRules: boolean;
  tokenFlag: string | undefined;
  noPrompt: boolean;
  setupForget: boolean;
  setupStdin: boolean;
  help: boolean;
  maxQuestions?: number;
  evidenceBudgetMs?: number;
  dryRun: boolean;
}

type ParsedArgs =
  | { ok: true; options: CliOptions }
  | { ok: false; help?: HelpCommand };

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

function isDebugMode(value: string): value is DebugMode {
  return value === "files" || value === "timings" || value === "cache";
}

function parseDebugModes(raw: string): DebugMode[] | undefined {
  const modes = raw.split(",").map((mode) => mode.trim()).filter((mode) => mode.length > 0);
  if (modes.length === 0 || !modes.every(isDebugMode)) return undefined;
  return [...new Set(modes)];
}

function baseOptions(command: "review" | "audit" | "setup"): CliOptions {
  const options: CliOptions = {
    command,
    paths: [],
    staged: false,
    format: "text",
    minScore: 0,
    cacheMode: "read-write",
    noErrorOnUnmatchedPattern: false,
    debug: [],
    printConfig: false,
    listRules: false,
    tokenFlag: undefined,
    noPrompt: false,
    setupForget: false,
    setupStdin: false,
    help: false,
    dryRun: false,
  };
  return options;
}

function parseFlags(args: string[], start: number, options: CliOptions): boolean {
  let cacheModeSet = false;
  let endOfFlags = false;
  for (let index = start; index < args.length; index += 1) {
    const argument = args[index] ?? "";
    if (!endOfFlags && argument === "--") {
      endOfFlags = true;
      continue;
    }
    if (!endOfFlags && (argument.startsWith("--") || argument === "-f" || argument.startsWith("-f="))) {
      if (argument === "--staged") {
        if (options.command === "audit") return false;
        options.staged = true;
      } else if (argument === "-f" || argument.startsWith("-f=")) {
        let value: string | undefined;
        if (argument === "-f") {
          value = args[index + 1];
          if (value === undefined) return false;
          index += 1;
        } else {
          value = argument.slice("-f=".length);
        }
        if (value !== "text" && value !== "json" && value !== "github") return false;
        options.format = value;
      } else if (argument === "--help") options.help = true;
      else if (argument === "--print-config") options.printConfig = true;
      else if (argument === "--rules") options.listRules = true;
      else if (argument === "--dry-run") {
        if (options.command !== "audit") return false;
        options.dryRun = true;
      } else if (argument === "--no-prompt") {
        options.noPrompt = true;
      } else if (argument === "--token" || argument.startsWith("--token=")) {
        let value: string | undefined;
        if (argument === "--token") {
          value = args[index + 1];
          if (value === undefined) return false;
          index += 1;
        } else {
          value = argument.slice("--token=".length);
        }
        options.tokenFlag = value;
      } else if (argument === "--no-error-on-unmatched-pattern") {
        options.noErrorOnUnmatchedPattern = true;
      } else if (argument === "--no-cache" || argument === "--refresh-cache") {
        if (cacheModeSet) return false;
        options.cacheMode = argument === "--no-cache" ? "disabled" : "refresh";
        cacheModeSet = true;
      } else if (argument === "--debug" || argument.startsWith("--debug=")) {
        let raw: string | undefined;
        if (argument === "--debug") {
          raw = args[index + 1];
          if (raw === undefined) return false;
          index += 1;
        } else {
          raw = argument.slice("--debug=".length);
        }
        const modes = parseDebugModes(raw);
        if (modes === undefined) return false;
        for (const mode of modes) {
          if (!options.debug.includes(mode)) options.debug.push(mode);
        }
      } else if (
        argument === "--format"
        || argument === "--config"
        || argument === "--min-score"
        || argument === "--limit"
        || argument === "--max-questions"
        || argument === "--evidence-budget-ms"
        || argument === "--out-dir"
      ) {
        const value = args[index + 1];
        if (value === undefined) return false;
        index += 1;
        if (argument === "--format") {
          if (value !== "text" && value !== "json" && value !== "github") return false;
          options.format = value;
        } else if (argument === "--out-dir") {
          if (value === "") return false;
          options.outDir = value;
        } else if (argument === "--config") {
          options.configPath = value;
        } else if (argument === "--min-score") {
          const parsed = score(value);
          if (parsed === undefined) return false;
          options.minScore = parsed;
        } else if (argument === "--max-questions") {
          if (options.command !== "audit") return false;
          const parsed = count(value, 1);
          if (parsed === undefined) return false;
          options.maxQuestions = parsed;
        } else if (argument === "--evidence-budget-ms") {
          if (options.command !== "audit") return false;
          const parsed = count(value, 0);
          if (parsed === undefined) return false;
          options.evidenceBudgetMs = parsed;
        } else {
          const parsed = limit(value);
          if (parsed === undefined) return false;
          options.limit = parsed;
        }
      } else {
        return false;
      }
    } else {
      options.paths.push(argument);
    }
  }
  return true;
}

function parseSetupFlags(args: string[], options: CliOptions): boolean {
  for (let index = 1; index < args.length; index += 1) {
    const argument = args[index] ?? "";
    if (argument === "--stdin") {
      if (options.setupForget) return false;
      options.setupStdin = true;
    } else if (argument === "--forget") {
      if (options.setupStdin) return false;
      options.setupForget = true;
    } else if (argument === "--no-prompt") {
      options.noPrompt = true;
    } else if (argument === "--help") {
      options.help = true;
    } else {
      return false;
    }
  }
  return true;
}

const USAGE_SETUP = `Usage: jevlint setup [options]

Ask for your Typesafe (Jev) API key and store it for future runs. The key is
kept in the OS keychain when available, otherwise in a private config file.
Run setup again to replace the stored key.

Options:
  --stdin            Read the key from stdin instead of asking (for scripts)
  --forget           Remove the stored key and exit
  --no-prompt        Fail with an error instead of asking (for scripts)
  --help             Show this help
`;

function parseArgs(args: string[]): ParsedArgs {
  if (args.length === 0) return { ok: true, options: baseOptions("audit") };
  if (args[0] === "--help" && args.length === 1) return { ok: false, help: "general" };
  const command = args[0];
  if (command === "setup") {
    const options = baseOptions("setup");
    if (!parseSetupFlags(args, options)) return { ok: false };
    if (options.help) return { ok: false, help: "setup" };
    return { ok: true, options };
  }
  if (command === "review" || command === "audit") {
    const options = baseOptions(command);
    if (!parseFlags(args, 1, options)) return { ok: false };
    if (options.help) return { ok: false, help: command };
    return { ok: true, options };
  }
  if (command === "diff") return { ok: false };
  const options = baseOptions("audit");
  if (!parseFlags(args, 0, options)) return { ok: false };
  if (options.help) return { ok: false, help: "general" };
  return { ok: true, options };
}

function normalizePattern(cwd: string, pattern: string): string | undefined {
  const trimmed = pattern.trim();
  if (trimmed === "" || trimmed === ".") return "";
  const rel = relative(cwd, resolve(cwd, trimmed));
  if (rel === "") return "";
  if (rel.startsWith("..") || isAbsolute(rel)) return undefined;
  return rel.split(sep).join("/");
}

async function filterByPaths<T extends { filePath: string }>(
  cwd: string,
  files: T[],
  patterns: string[],
): Promise<T[]> {
  const matched = new Set<string>();
  for (const pattern of patterns) {
    const normalized = normalizePattern(cwd, pattern);
    if (normalized === undefined) continue;
    let isDirectory = normalized === "";
    if (!isDirectory) {
      try {
        isDirectory = (await stat(resolve(cwd, normalized))).isDirectory();
      } catch {
        continue;
      }
    }
    for (const file of files) {
      const hit = isDirectory
        ? normalized === "" || file.filePath === normalized || file.filePath.startsWith(`${normalized}/`)
        : file.filePath === normalized;
      if (hit) matched.add(file.filePath);
    }
  }
  return files.filter((file) => matched.has(file.filePath));
}

const ruleIdHolderSchema = z.object({ ruleId: z.string().min(1) });

function ruleIdFromQuestion(question: NoulQuestion): string {
  const parsed = ruleIdHolderSchema.safeParse(question.instructions);
  return parsed.success ? parsed.data.ruleId : "unknown";
}

interface RuleTiming {
  questions: number;
  ms: number;
}

class TimingEvaluator implements Evaluator {
  constructor(
    private readonly delegate: Evaluator,
    private readonly timings: Map<string, RuleTiming>,
  ) {}

  async evaluate(request: EvaluationRequest): Promise<Record<string, number>> {
    const entries = Object.entries(request.questions);
    const start = Date.now();
    try {
      return await this.delegate.evaluate(request);
    } finally {
      const elapsed = Date.now() - start;
      const share = entries.length > 0 ? elapsed / entries.length : 0;
      for (const [, question] of entries) {
        const ruleId = ruleIdFromQuestion(question);
        const timing = this.timings.get(ruleId) ?? { questions: 0, ms: 0 };
        timing.questions += 1;
        timing.ms += share;
        this.timings.set(ruleId, timing);
      }
    }
  }
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

interface FileBucket {
  judgments: Judgment[];
  abstentions: StructuralAbstentionCount[];
}

async function writeBucketArtifact(
  outDir: string,
  filePath: string,
  bucket: FileBucket,
): Promise<void> {
  await writeFileArtifact(outDir, createFileArtifact(filePath, bucket.judgments, bucket.abstentions));
}

async function finishRun(
  run: FinishedRun,
  options: CliOptions,
  stdout: (text: string) => void,
  stderr: (text: string) => void,
  outDir?: string,
): Promise<number> {
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
  let output: string;
  if (options.format === "json") {
    output = formatJson(report);
  } else if (options.format === "github") {
    output = formatGithub(report);
  } else {
    output = formatText(report);
  }
  if (output !== "") stdout(`${output}\n`);

  for (const failure of failures.slice(0, MAX_REPORTED_FAILURES)) {
    stderr(
      `jevlint: ${failure.filePath}: ${failure.questionCount} evaluation question${failure.questionCount === 1 ? "" : "s"} failed (${failure.ruleIds.join(", ")}): ${failure.message}\n`,
    );
  }
  if (failures.length > MAX_REPORTED_FAILURES) {
    stderr(`jevlint: ${failures.length - MAX_REPORTED_FAILURES} additional evaluation failures omitted.\n`);
  }
  if (options.debug.includes("cache")) {
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
  if (outDir !== undefined) {
    try {
      await writeSummaryArtifact(outDir, report);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      stderr(`jevlint: cannot write output directory ${outDir}: ${message}\n`);
      return 2;
    }
  }
  return failures.length > 0 ? 2 : 0;
}

function reportTimings(
  timings: Map<string, RuleTiming>,
  stderr: (text: string) => void,
): void {
  stderr("jevlint timings:\n");
  const rows = [...timings.entries()]
    .sort(([left], [right]) => left.localeCompare(right));
  for (const [ruleId, timing] of rows) {
    stderr(
      `${ruleId}  ${timing.questions} question${timing.questions === 1 ? "" : "s"}  ${Math.round(timing.ms)} ms\n`,
    );
  }
}

const dryRunEvaluator: Evaluator = {
  async evaluate(): Promise<Record<string, number>> {
    throw new Error("dry run prepares questions without calling the evaluator");
  },
};

async function ensureLiveCredential(input: EnsureCredentialInput): Promise<CredentialOutcome> {
  const resolved = input.authIO === undefined
    ? await resolveCredential({ tokenFlag: input.tokenFlag })
    : await resolveCredentialWithIO({ tokenFlag: input.tokenFlag }, input.authIO);
  if (resolved !== undefined) return { ok: true, credential: resolved };
  const io = input.authIO ?? defaultAuthIO();
  if (input.tokenFlag !== undefined || input.noPrompt || input.stdin.isTTY !== true) {
    input.stderr(`${MISSING_CREDENTIAL_MESSAGE}\n`);
    return { ok: false, exitCode: 2 };
  }
  let entered: string;
  try {
    entered = await promptForApiKey(input.stdin, input.stderr);
  } catch (error) {
    if (error instanceof SetupCancelledError) {
      input.stderr(`${SETUP_CANCELLED_MESSAGE}\n`);
      return { ok: false, exitCode: 2 };
    }
    throw error;
  }
  const token = entered.trim();
  if (token.length === 0) {
    input.stderr(`${SETUP_CANCELLED_MESSAGE}\n`);
    return { ok: false, exitCode: 2 };
  }
  const backend = await storeCredential(token, io);
  return { ok: true, credential: { token, source: backend } };
}

async function runSetup(
  options: CliOptions,
  dependencies: CliDependencies,
  stderr: (text: string) => void,
): Promise<number> {
  const io = dependencies.authIO ?? defaultAuthIO();
  const stdin: PromptStdin = dependencies.stdin ?? process.stdin;
  if (options.setupForget) {
    await removeStoredCredential(io);
    stderr(`${STORED_REMOVED_MESSAGE}\n`);
    return 0;
  }
  if (options.setupStdin) {
    const raw = await readKeyFromStdin(stdin);
    const token = raw.trim();
    if (token.length === 0) {
      stderr(`${EMPTY_STDIN_MESSAGE}\n`);
      return 2;
    }
    const backend = await storeCredential(token, io);
    stderr(`${STORED_PREFIX} (${storedBackendLabel(backend)}).\n`);
    return 0;
  }
  if (stdin.isTTY !== true) {
    stderr(`${MISSING_CREDENTIAL_MESSAGE}\n`);
    return 2;
  }
  let entered: string;
  try {
    entered = await promptForApiKey(stdin, stderr);
  } catch (error) {
    if (error instanceof SetupCancelledError) {
      stderr(`${SETUP_CANCELLED_MESSAGE}\n`);
      return 2;
    }
    throw error;
  }
  const token = entered.trim();
  if (token.length === 0) {
    stderr(`${SETUP_CANCELLED_MESSAGE}\n`);
    return 2;
  }
  const backend = await storeCredential(token, io);
  stderr(`${STORED_PREFIX} (${storedBackendLabel(backend)}).\n`);
  return 0;
}

async function resolveEvaluator(
  cwd: string,
  options: CliOptions,
  dependencies: CliDependencies,
  credential: LiveCredential | undefined,
): Promise<{ evaluator: Evaluator; cachedEvaluator: CachedEvaluator | undefined }> {
  let cachedEvaluator: CachedEvaluator | undefined;
  let evaluator = dependencies.evaluator;
  if (evaluator instanceof CachedEvaluator) cachedEvaluator = evaluator;
  if (!evaluator) {
    if (credential === undefined) throw new Error("live evaluation needs a Typesafe API key");
    const liveEvaluator = new TypeSafeEvaluator({
      apiKey: credential.token,
      credentialSource: credential.source,
    });
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

function printRules(options: CliOptions, stdout: (text: string) => void): number {
  const keys = Object.keys(defaultConfig.rules);
  if (options.format === "json") {
    stdout(`${JSON.stringify(keys)}\n`);
  } else {
    for (const key of keys) stdout(`${key}\n`);
  }
  return 0;
}

async function runAudit(
  cwd: string,
  options: CliOptions,
  dependencies: CliDependencies,
  stdout: (text: string) => void,
  stderr: (text: string) => void,
): Promise<number> {
  if (options.listRules) return printRules(options, stdout);
  const configPromise = options.configPath === undefined
    ? loadConfig({ cwd })
    : loadConfig({ cwd, configPath: options.configPath });
  const [config, allProjectFiles] = await Promise.all([
    configPromise,
    collectRepositoryFiles({ cwd, staged: false }),
  ]);
  if (options.printConfig) {
    stdout(`${JSON.stringify(config, null, 2)}\n`);
    return 0;
  }
  const projectFiles = options.paths.length === 0
    ? allProjectFiles
    : await filterByPaths(cwd, allProjectFiles, options.paths);

  if (options.debug.includes("files")) {
    for (const file of projectFiles) stderr(`${file.filePath}\n`);
    return 0;
  }
  if (projectFiles.length === 0 && options.paths.length > 0 && !options.noErrorOnUnmatchedPattern) {
    stderr("jevlint: no files matched the given paths\n");
    return 2;
  }

  let cachedEvaluator: CachedEvaluator | undefined;
  let evaluator: Evaluator = dryRunEvaluator;
  if (!options.dryRun) {
    let credential: LiveCredential | undefined;
    if (dependencies.evaluator === undefined) {
      const outcome = await ensureLiveCredential({
        tokenFlag: options.tokenFlag,
        noPrompt: options.noPrompt,
        stdin: dependencies.stdin ?? process.stdin,
        stderr,
        authIO: dependencies.authIO,
      });
      if (!outcome.ok) return outcome.exitCode;
      credential = outcome.credential;
    }
    const resolved = await resolveEvaluator(cwd, options, dependencies, credential);
    evaluator = resolved.evaluator;
    cachedEvaluator = resolved.cachedEvaluator;
  } else if (dependencies.evaluator) {
    evaluator = dependencies.evaluator;
  }
  const timings = new Map<string, RuleTiming>();
  if (options.debug.includes("timings")) {
    evaluator = new TimingEvaluator(evaluator, timings);
  }
  const auditInput: AnalyzeAuditInput = {
    projectFiles,
    config,
    dryRun: options.dryRun,
  };
  const outDir = options.outDir === undefined ? undefined : resolve(cwd, options.outDir);
  if (outDir !== undefined) {
    auditInput.onFileComplete = (artifact) => writeFileArtifact(outDir, artifact);
  }
  if (options.maxQuestions !== undefined) {
    auditInput.maxQuestions = options.maxQuestions;
  }
  if (options.evidenceBudgetMs !== undefined) {
    auditInput.evidenceBudgetMs = options.evidenceBudgetMs;
  }
  const result = await analyzeAuditWithFailures(auditInput, evaluator);
  const exitCode = await finishRun(
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
    outDir,
  );
  if (options.debug.includes("timings")) {
    reportTimings(timings, stderr);
  }
  return exitCode;
}

async function runReview(
  cwd: string,
  options: CliOptions,
  dependencies: CliDependencies,
  stdout: (text: string) => void,
  stderr: (text: string) => void,
): Promise<number> {
  if (options.listRules) return printRules(options, stdout);
  const configPromise = options.configPath === undefined
    ? loadConfig({ cwd })
    : loadConfig({ cwd, configPath: options.configPath });
  const [config, changed, projectFiles] = await Promise.all([
    configPromise,
    collectChangedFiles({ cwd, staged: options.staged }),
    collectRepositoryFiles({ cwd, staged: options.staged }),
  ]);
  if (options.printConfig) {
    stdout(`${JSON.stringify(config, null, 2)}\n`);
    return 0;
  }
  const scope = options.paths.length === 0
    ? changed
    : await filterByPaths(cwd, changed, options.paths);

  if (options.debug.includes("files")) {
    for (const file of scope) stderr(`${file.filePath}\n`);
    return 0;
  }
  if (scope.length === 0 && options.paths.length > 0 && !options.noErrorOnUnmatchedPattern) {
    stderr("jevlint: no files matched the given paths\n");
    return 2;
  }

  let credential: LiveCredential | undefined;
  if (dependencies.evaluator === undefined) {
    const outcome = await ensureLiveCredential({
      tokenFlag: options.tokenFlag,
      noPrompt: options.noPrompt,
      stdin: dependencies.stdin ?? process.stdin,
      stderr,
      authIO: dependencies.authIO,
    });
    if (!outcome.ok) return outcome.exitCode;
    credential = outcome.credential;
  }
  const { evaluator: resolvedEvaluator, cachedEvaluator } = await resolveEvaluator(cwd, options, dependencies, credential);
  let evaluator = resolvedEvaluator;
  const timings = new Map<string, RuleTiming>();
  if (options.debug.includes("timings")) {
    evaluator = new TimingEvaluator(evaluator, timings);
  }
  const judgments: Judgment[] = [];
  const abstentions: StructuralAbstentionCount[] = [];
  const failures: EvaluationFailure[] = [];
  const statistics: EvaluationStatistics = { requests: 0, questions: 0 };
  const outDir = options.outDir === undefined ? undefined : resolve(cwd, options.outDir);
  const buckets = new Map<string, FileBucket>();

  function bucketFor(filePath: string): FileBucket {
    const bucket = buckets.get(filePath) ?? { judgments: [], abstentions: [] };
    buckets.set(filePath, bucket);
    return bucket;
  }

  async function absorbFileResult(filePath: string, result: AnalysisResult): Promise<void> {
    const bucket = bucketFor(filePath);
    bucket.judgments.push(...result.judgments);
    bucket.abstentions.push(...result.abstentions);
    if (outDir !== undefined) await writeBucketArtifact(outDir, filePath, bucket);
  }

  async function absorbSharedResult(result: AnalysisResult, fallbackFiles: string[]): Promise<void> {
    const touched: string[] = [];
    for (const judgment of result.judgments) {
      if (!touched.includes(judgment.filePath)) touched.push(judgment.filePath);
      bucketFor(judgment.filePath).judgments.push(judgment);
    }
    if (result.abstentions.length > 0) {
      const host = touched[0] ?? fallbackFiles[0];
      if (host !== undefined) {
        bucketFor(host).abstentions.push(...result.abstentions);
        if (!touched.includes(host)) touched.push(host);
      }
    }
    if (outDir !== undefined) {
      for (const filePath of touched) {
        const bucket = buckets.get(filePath);
        if (bucket !== undefined) await writeBucketArtifact(outDir, filePath, bucket);
      }
    }
  }

  for (const file of scope) {
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
    await absorbFileResult(file.filePath, result);
  }
  const changeResult = await analyzeChangesWithFailures(
    { changes: scope, config, projectFiles },
    evaluator,
  );
  judgments.push(...changeResult.judgments);
  abstentions.push(...changeResult.abstentions);
  failures.push(...changeResult.failures);
  addStatistics(statistics, changeResult.statistics);
  await absorbSharedResult(changeResult, scope.map((file) => file.filePath));
  const moduleResult = await analyzeModulesWithFailures(
    { changes: scope, config, projectFiles },
    evaluator,
  );
  judgments.push(...moduleResult.judgments);
  abstentions.push(...moduleResult.abstentions);
  failures.push(...moduleResult.failures);
  addStatistics(statistics, moduleResult.statistics);
  await absorbSharedResult(moduleResult, scope.map((file) => file.filePath));

  const exitCode = await finishRun(
    { judgments, abstentions, failures, statistics, cachedEvaluator, coverage: undefined },
    options,
    stdout,
    stderr,
    outDir,
  );
  if (options.debug.includes("timings")) {
    reportTimings(timings, stderr);
  }
  return exitCode;
}

export async function runCli(args: string[], dependencies: CliDependencies = {}): Promise<number> {
  const stdout = dependencies.stdout ?? ((text: string) => process.stdout.write(text));
  const stderr = dependencies.stderr ?? ((text: string) => process.stderr.write(text));
  const parsed = parseArgs(args);

  if (!parsed.ok) {
    if (parsed.help === "setup") {
      stdout(USAGE_SETUP);
      return 0;
    }
    if (parsed.help === "review") {
      stdout(USAGE_REVIEW);
      return 0;
    }
    if (parsed.help === "audit") {
      stdout(USAGE_AUDIT);
      return 0;
    }
    if (parsed.help === "general") {
      stdout(USAGE_GENERAL);
      return 0;
    }
    stderr(USAGE_GENERAL);
    return 2;
  }

  const cwd = dependencies.cwd ?? process.cwd();
  try {
    if (parsed.options.command === "setup") {
      return await runSetup(parsed.options, dependencies, stderr);
    }
    if (parsed.options.command === "audit") {
      return await runAudit(cwd, parsed.options, dependencies, stdout, stderr);
    }
    return await runReview(cwd, parsed.options, dependencies, stdout, stderr);
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
