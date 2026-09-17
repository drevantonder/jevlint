#!/usr/bin/env node

import { pathToFileURL } from "node:url";
import { analyzeChanges, analyzeFile } from "./analyze.js";
import { loadConfig } from "./config.js";
import { deduplicateDiagnostics } from "./deduplicate.js";
import { formatJson, formatText } from "./format.js";
import { collectChangedFiles, collectRepositoryFiles } from "./git.js";
import { TypeSafeEvaluator } from "./typesafe-evaluator.js";
import type { Diagnostic, Evaluator } from "./types.js";

const USAGE = `Usage: jevlint diff [options]

Options:
  --staged          Analyze staged changes
  --format <format> Output text or json
  --config <path>   Use a specific config file
  --help            Show this help
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
  help: boolean;
}

function parseArgs(args: string[]): CliOptions | undefined {
  if (args[0] !== "diff") return undefined;

  const options: CliOptions = { staged: false, format: "text", help: false };
  for (let index = 1; index < args.length; index += 1) {
    const argument = args[index];
    if (argument === "--staged") options.staged = true;
    else if (argument === "--help") options.help = true;
    else if (argument === "--format" || argument === "--config") {
      const value = args[index + 1];
      if (!value) return undefined;
      index += 1;
      if (argument === "--format") {
        if (value !== "text" && value !== "json") return undefined;
        options.format = value;
      } else {
        options.configPath = value;
      }
    } else {
      return undefined;
    }
  }
  return options;
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
    const evaluator = dependencies.evaluator ?? new TypeSafeEvaluator();
    const diagnostics: Diagnostic[] = [];

    for (const file of files) {
      diagnostics.push(
        ...(await analyzeFile(
          {
            filePath: file.filePath,
            source: file.source,
            changedLines: file.changedLines,
            config,
            projectFiles,
          },
          evaluator,
        )),
      );
    }
    diagnostics.push(...await analyzeChanges({ changes: files, config, projectFiles }, evaluator));

    const finalDiagnostics = deduplicateDiagnostics(diagnostics);
    const output = options.format === "json"
      ? formatJson(finalDiagnostics)
      : formatText(finalDiagnostics);
    if (output.length > 0 || options.format === "json") stdout(`${output}\n`);
    return finalDiagnostics.some((diagnostic) => diagnostic.severity === "error") ? 1 : 0;
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
