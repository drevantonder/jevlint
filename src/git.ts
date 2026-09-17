import { execFile as execFileCallback } from "node:child_process";
import { readFile } from "node:fs/promises";
import { extname, resolve } from "node:path";
import { promisify } from "node:util";
import { parseChangedLineRanges } from "./changed-lines.js";
import type { LineRange, ProjectFile, SourceFile } from "./types.js";

const execFile = promisify(execFileCallback);
const SOURCE_EXTENSIONS = new Set([".js", ".jsx", ".mjs", ".cjs", ".ts", ".tsx", ".mts", ".cts"]);

interface GitOptions {
  cwd: string;
  staged: boolean;
}

async function git(cwd: string, args: string[]): Promise<string> {
  const { stdout } = await execFile("git", args, {
    cwd,
    encoding: "utf8",
    maxBuffer: 20 * 1024 * 1024,
  });
  return stdout;
}

async function hasHead(cwd: string): Promise<boolean> {
  try {
    await git(cwd, ["rev-parse", "--verify", "HEAD"]);
    return true;
  } catch {
    return false;
  }
}

function pathsFromNullSeparated(output: string): string[] {
  return output.split("\0").filter(Boolean);
}

function isSourceFile(path: string): boolean {
  return SOURCE_EXTENSIONS.has(extname(path).toLowerCase());
}

function allLines(source: string): LineRange[] {
  if (source.length === 0) return [];
  const lineCount = source.endsWith("\n")
    ? source.split("\n").length - 1
    : source.split("\n").length;
  return [{ start: 1, end: Math.max(1, lineCount) }];
}

async function fileSource(cwd: string, path: string, staged: boolean): Promise<string | undefined> {
  try {
    return staged ? await git(cwd, ["show", `:${path}`]) : await readFile(resolve(cwd, path), "utf8");
  } catch {
    return undefined;
  }
}

async function oldFileSource(cwd: string, path: string, headExists: boolean): Promise<string | null> {
  if (!headExists) return null;
  try {
    return await git(cwd, ["show", `HEAD:${path}`]);
  } catch {
    return null;
  }
}

export async function collectRepositoryFiles(options: GitOptions): Promise<ProjectFile[]> {
  const trackedOutput = await git(options.cwd, ["ls-files", "-z"]);
  const paths = pathsFromNullSeparated(trackedOutput);
  if (!options.staged) {
    const untrackedOutput = await git(options.cwd, ["ls-files", "--others", "--exclude-standard", "-z"]);
    paths.push(...pathsFromNullSeparated(untrackedOutput));
  }

  const files: ProjectFile[] = [];
  for (const path of [...new Set(paths.filter(isSourceFile))].sort()) {
    const source = await fileSource(options.cwd, path, options.staged);
    if (source !== undefined) files.push({ filePath: path, source });
  }
  return files;
}

export async function collectChangedFiles(options: GitOptions): Promise<SourceFile[]> {
  const headExists = await hasHead(options.cwd);
  let paths: string[];

  if (options.staged) {
    const output = await git(options.cwd, [
      "diff",
      "--cached",
      "--name-only",
      "--diff-filter=ACMR",
      "-z",
      "--",
    ]);
    paths = pathsFromNullSeparated(output);
  } else if (headExists) {
    const [changed, untracked] = await Promise.all([
      git(options.cwd, ["diff", "HEAD", "--name-only", "--diff-filter=ACMR", "-z", "--"]),
      git(options.cwd, ["ls-files", "--others", "--exclude-standard", "-z"]),
    ]);
    paths = [...pathsFromNullSeparated(changed), ...pathsFromNullSeparated(untracked)];
  } else {
    const output = await git(options.cwd, ["ls-files", "--cached", "--others", "--exclude-standard", "-z"]);
    paths = pathsFromNullSeparated(output);
  }

  const uniquePaths = [...new Set(paths.filter(isSourceFile))].sort();
  const files: SourceFile[] = [];

  for (const path of uniquePaths) {
    const source = await fileSource(options.cwd, path, options.staged);
    if (source === undefined) continue;

    let changedLines: LineRange[];
    if (!headExists || (!options.staged && pathsFromNullSeparated(
      await git(options.cwd, ["ls-files", "--others", "--exclude-standard", "-z", "--", path]),
    ).includes(path))) {
      changedLines = allLines(source);
    } else {
      const args = options.staged
        ? ["diff", "--cached", "--unified=0", "--no-color", "--no-ext-diff", "--", path]
        : ["diff", "HEAD", "--unified=0", "--no-color", "--no-ext-diff", "--", path];
      changedLines = parseChangedLineRanges(await git(options.cwd, args));
    }

    if (changedLines.length > 0) {
      files.push({
        filePath: path,
        source,
        oldSource: await oldFileSource(options.cwd, path, headExists),
        changedLines,
      });
    }
  }

  return files;
}
