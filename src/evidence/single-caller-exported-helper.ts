import { execFileSync } from "node:child_process";
import { z } from "zod";
import { parseCached } from "./parse-cache.js";
import type { Candidate, ProjectFile } from "../types.js";
import {
  findDirectFunction,
  findFunctionCallersAndReferencesWithCoverage,
  findModuleImporters,
  functionName,
  isFunctionExported,
  resolveModule,
} from "./repository.js";
import type { FunctionCaller } from "./repository.js";
import { findTransitiveTestPins, partitionCallersByTest } from "./test-scope.js";
import type { TransitivePin } from "./test-scope.js";

export type SingleCallerReexport = {
  reexported: boolean;
  reexportPaths: string[];
};

export type SingleCallerTestContracts = {
  direct: FunctionCaller[];
  directCount: number;
  transitive: TransitivePin[];
  transitiveCount: number;
};

export type SingleCallerPublicReachability = {
  exportsMapPresent: boolean;
  exportsMentionsOwner: boolean;
  barrelFile: string | null;
  viaBarrel: boolean;
  reachable: boolean;
};

export type SingleCallerCoChange =
  | {
      available: false;
      reason: "no-repo-configured" | "no-readable-head" | "history-unreadable" | "file-untracked";
      commitCap: number;
    }
  | {
      available: true;
      commitCap: number;
      helperCommits: number;
      callerCommits: number;
      sharedCommits: number;
      truncated: boolean;
      untouchedSinceScaffold: boolean;
      seamHolds: boolean;
    };

export type SingleCallerExportedHelperEvidence = {
  function: {
    name: string;
    exported: boolean;
    filePath: string;
    source: string;
    paramCount: number;
  };
  totalCallers: number;
  caller: FunctionCaller;
  callerOwnership: "same-file" | "importing-module" | "unresolved";
  sameFileCaller: boolean;
  testCallers: FunctionCaller[];
  testCallerCount: number;
  testContracts: SingleCallerTestContracts;
  reexport: SingleCallerReexport;
  publicReachability: SingleCallerPublicReachability;
  coChange: SingleCallerCoChange;
};

function reexportPaths(
  ownerPath: string,
  name: string,
  projectFiles: ProjectFile[],
): string[] {
  const paths: string[] = [];
  for (const file of projectFiles) {
    if (file.filePath === ownerPath) continue;
    const parsed = parseCached(file.filePath, file.source);
    if (parsed.errors.some((error) => error.severity === "Error")) continue;
    for (const statement of parsed.program.body) {
      if (statement.type === "ExportAllDeclaration") {
        const resolved = resolveModule(file.filePath, statement.source.value, projectFiles);
        if (resolved?.filePath === ownerPath) paths.push(file.filePath);
      } else if (statement.type === "ExportNamedDeclaration" && statement.source) {
        const resolved = resolveModule(file.filePath, statement.source.value, projectFiles);
        if (resolved?.filePath !== ownerPath) continue;
        const names = statement.specifiers.map((specifier) => {
          if (specifier.local.type === "Identifier") return specifier.local.name;
          return specifier.exported.type === "Identifier" ? specifier.exported.name : "";
        });
        if (names.includes(name) || statement.specifiers.length === 0) paths.push(file.filePath);
      }
    }
  }
  return [...new Set(paths)].slice(0, 8);
}

function isIndexBarrel(filePath: string): boolean {
  const base = filePath.replaceAll("\\", "/").split("/").pop() ?? filePath;
  return /^index\.[cm]?[jt]sx?$/.test(base);
}

function baseNameOf(filePath: string): string {
  return filePath.replaceAll("\\", "/").split("/").pop() ?? filePath;
}

function dirOf(filePath: string): string {
  const normalized = filePath.replaceAll("\\", "/");
  const slash = normalized.lastIndexOf("/");
  return slash < 0 ? "" : normalized.slice(0, slash);
}

function stemOf(filePath: string): string {
  const base = baseNameOf(filePath);
  const dot = base.lastIndexOf(".");
  return dot <= 0 ? base : base.slice(0, dot);
}

interface ExportsRecord {
  [key: string]: ExportsNode;
}

interface ExportsList extends Array<ExportsNode> {}

type ExportsNode = string | ExportsList | ExportsRecord;

const exportsNodeSchema: z.ZodType<ExportsNode> = z.union([
  z.string(),
  z.array(z.lazy((): z.ZodType<ExportsNode> => exportsNodeSchema)),
  z.record(z.string(), z.lazy((): z.ZodType<ExportsNode> => exportsNodeSchema)),
]);

const manifestSchema = z.object({ exports: exportsNodeSchema.optional() });

function isExportsRecord(node: ExportsNode): node is ExportsRecord {
  return !Array.isArray(node) && z.string().safeParse(node).success === false;
}

function exportsStrings(node: ExportsNode): string[] {
  const asString = z.string().safeParse(node);
  if (asString.success) return [asString.data];
  if (Array.isArray(node)) return node.flatMap(exportsStrings);
  if (!isExportsRecord(node)) return [];
  return Object.keys(node).flatMap((key) => {
    const child: ExportsNode | undefined = node[key];
    return child === undefined ? [key] : [key, ...exportsStrings(child)];
  });
}

function nearestManifest(ownerPath: string, projectFiles: ProjectFile[]): ProjectFile | undefined {
  let best: ProjectFile | undefined;
  let bestDepth = -1;
  for (const file of projectFiles) {
    if (baseNameOf(file.filePath) !== "package.json") continue;
    const dir = dirOf(file.filePath);
    if (dir !== "" && ownerPath !== dir && !ownerPath.startsWith(`${dir}/`)) continue;
    if (dir.length > bestDepth) {
      best = file;
      bestDepth = dir.length;
    }
  }
  return best;
}

function buildPublicReachability(
  ownerPath: string,
  projectFiles: ProjectFile[],
  reexportedPaths: string[],
): SingleCallerPublicReachability {
  const barrelFile = reexportedPaths.find((path) => isIndexBarrel(path)) ?? null;
  const viaBarrel = barrelFile !== null;
  const manifest = nearestManifest(ownerPath, projectFiles);
  if (!manifest) {
    return {
      exportsMapPresent: false,
      exportsMentionsOwner: false,
      barrelFile,
      viaBarrel,
      reachable: viaBarrel,
    };
  }
  let parsed: unknown;
  try {
    // JSON.parse returns any; assigning into unknown keeps every later use
    // behind zod validation instead of spreading the implicit any.
    const raw: unknown = JSON.parse(manifest.source);
    parsed = raw;
  } catch {
    return {
      exportsMapPresent: false,
      exportsMentionsOwner: false,
      barrelFile,
      viaBarrel,
      reachable: viaBarrel,
    };
  }
  const manifestResult = manifestSchema.safeParse(parsed);
  if (!manifestResult.success || manifestResult.data.exports === undefined) {
    return {
      exportsMapPresent: false,
      exportsMentionsOwner: false,
      barrelFile,
      viaBarrel,
      reachable: viaBarrel,
    };
  }
  const stem = stemOf(ownerPath);
  const mentions = stem.length > 0
    && exportsStrings(manifestResult.data.exports).some((entry) => entry.includes(stem));
  return {
    exportsMapPresent: true,
    exportsMentionsOwner: mentions,
    barrelFile,
    viaBarrel,
    reachable: mentions || viaBarrel,
  };
}

// Co-change history is opt-in through JEVLINT_COHANGE_REPO (a repository root
// whose working tree contains the analyzed files at matching relative paths).
// Without it the review path stays pure and deterministic: no subprocess, no
// filesystem reads, and coChange reports available:false as a named fact.
// Bound: one capped `git log` per file (helper + caller), cached per file+HEAD.
const CO_CHANGE_REPO_ENV = "JEVLINT_COHANGE_REPO";
const CO_CHANGE_COMMIT_CAP = 20;

const coChangeLogCache = new Map<string, { head: string; commits: string[] }>();

export function clearSingleCallerCoChangeCache(): void {
  coChangeLogCache.clear();
}

export function singleCallerCoChangeCommitCap(): number {
  return CO_CHANGE_COMMIT_CAP;
}

function gitHead(repoRoot: string): string | undefined {
  try {
    return execFileSync("git", ["rev-parse", "HEAD"], { cwd: repoRoot, encoding: "utf8" }).trim();
  } catch {
    return undefined;
  }
}

function gitFileLog(repoRoot: string, filePath: string): string[] | undefined {
  try {
    const output = execFileSync(
      "git",
      ["log", "--format=%H", "-n", String(CO_CHANGE_COMMIT_CAP), "--", filePath],
      { cwd: repoRoot, encoding: "utf8" },
    );
    return output.split("\n").map((line) => line.trim()).filter((line) => line.length > 0);
  } catch {
    return undefined;
  }
}

function cachedFileLog(repoRoot: string, head: string, filePath: string): string[] | undefined {
  const cached = coChangeLogCache.get(`${repoRoot}\u0000${filePath}`);
  if (cached !== undefined && cached.head === head) return cached.commits;
  const commits = gitFileLog(repoRoot, filePath);
  if (commits === undefined) return undefined;
  coChangeLogCache.set(`${repoRoot}\u0000${filePath}`, { head, commits });
  return commits;
}

function buildCoChange(ownerPath: string, callerPath: string): SingleCallerCoChange {
  const repoRoot = process.env[CO_CHANGE_REPO_ENV];
  if (repoRoot === undefined || repoRoot.length === 0) {
    return { available: false, reason: "no-repo-configured", commitCap: CO_CHANGE_COMMIT_CAP };
  }
  const head = gitHead(repoRoot);
  if (head === undefined) {
    return { available: false, reason: "no-readable-head", commitCap: CO_CHANGE_COMMIT_CAP };
  }
  const helperLog = cachedFileLog(repoRoot, head, ownerPath);
  const callerLog = cachedFileLog(repoRoot, head, callerPath);
  if (helperLog === undefined || callerLog === undefined) {
    return { available: false, reason: "history-unreadable", commitCap: CO_CHANGE_COMMIT_CAP };
  }
  if (helperLog.length === 0 || callerLog.length === 0) {
    return { available: false, reason: "file-untracked", commitCap: CO_CHANGE_COMMIT_CAP };
  }
  const truncated = helperLog.length >= CO_CHANGE_COMMIT_CAP
    || callerLog.length >= CO_CHANGE_COMMIT_CAP;
  const callerSet = new Set(callerLog);
  let shared = 0;
  for (const commit of helperLog) {
    if (callerSet.has(commit)) shared += 1;
  }
  const untouchedSinceScaffold = !truncated && helperLog.length <= 1;
  return {
    available: true,
    commitCap: CO_CHANGE_COMMIT_CAP,
    helperCommits: helperLog.length,
    callerCommits: callerLog.length,
    sharedCommits: shared,
    truncated,
    untouchedSinceScaffold,
    seamHolds: untouchedSinceScaffold && shared === 0,
  };
}

export function buildSingleCallerExportedHelperEvidence(
  candidate: Candidate,
  projectFiles: ProjectFile[],
): SingleCallerExportedHelperEvidence | undefined {
  if (candidate.kind !== "function") return undefined;
  const owner = projectFiles.find((file) => file.filePath === candidate.filePath);
  if (!owner) return undefined;
  const parsed = parseCached(owner.filePath, owner.source);
  if (parsed.errors.some((error) => error.severity === "Error")) return undefined;
  const fn = findDirectFunction(parsed.program, candidate);
  if (!fn) return undefined;
  const name = functionName(parsed.program, fn);
  if (!name) return undefined;
  if (!isFunctionExported(parsed.program, fn, name)) return undefined;

  // A lone reference-as-value (`const g = fn`) is still exactly one
  // production consumer, so it lands in the single-caller seam as the caller.
  const coverage = findFunctionCallersAndReferencesWithCoverage(
    owner.filePath,
    name,
    projectFiles,
    { start: fn.start, end: fn.end },
  );
  const { production, test } = partitionCallersByTest(coverage.callers);
  if (production.length !== 1) return undefined;
  const caller = production[0];
  if (!caller) return undefined;

  const ownership: SingleCallerExportedHelperEvidence["callerOwnership"] =
    caller.filePath === owner.filePath
      ? "same-file"
      : findModuleImporters(owner.filePath, projectFiles).some(({ filePath }) => filePath === caller.filePath)
        ? "importing-module"
        : "unresolved";

  const paths = reexportPaths(owner.filePath, name, projectFiles);
  const transitive = findTransitiveTestPins(owner.filePath, name, projectFiles);

  return {
    function: {
      name,
      exported: true,
      filePath: owner.filePath,
      source: candidate.source,
      paramCount: fn.params.length,
    },
    totalCallers: production.length,
    caller,
    callerOwnership: ownership,
    sameFileCaller: caller.filePath === owner.filePath,
    testCallers: test.slice(0, 10),
    testCallerCount: test.length,
    testContracts: {
      direct: test.slice(0, 10),
      directCount: test.length,
      transitive,
      transitiveCount: transitive.length,
    },
    reexport: {
      reexported: paths.length > 0,
      reexportPaths: paths,
    },
    publicReachability: buildPublicReachability(owner.filePath, projectFiles, paths),
    coChange: buildCoChange(owner.filePath, caller.filePath),
  };
}
