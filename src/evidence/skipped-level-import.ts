import { posix } from "node:path";
import type { Candidate, ProjectFile, SourceFile } from "../types.js";
import {
  buildModuleEvidence,
  buildModuleGraph,
  dirOf,
  parseProgram,
} from "./module.js";
import type { ModuleEvidence } from "./module.js";
import { moduleImports, resolveModule } from "./repository.js";

const CLIMB_PATTERN = /^(\.\.\/)+/;
const MAX_CLIMB_DETAILS = 10;

export type SkippedLevelImportEvidence = {
  module: ModuleEvidence;
  climbs: {
    specifier: string;
    levels: number;
    resolved: string;
    alternative: { kind: "barrel"; path: string } | { kind: "alias" } | null;
  }[];
  repoTypicalClimb: number;
  aliasAvailable: boolean;
};

function climbLevels(specifier: string): number {
  const match = CLIMB_PATTERN.exec(specifier);
  if (!match) return 0;
  return match[0].split("../").length - 1;
}

function previousSpecifiers(filePath: string, oldSource: string | null): Set<string> | undefined {
  if (oldSource === null) return new Set();
  const program = parseProgram(filePath, oldSource);
  if (!program) return undefined;
  return new Set(moduleImports(program).map((item) => item.source));
}

function nearestBarrel(resolved: string, projectFiles: ProjectFile[]): string | null {
  let dir = dirOf(resolved);
  for (;;) {
    const barrel = projectFiles.find((file) =>
      dirOf(file.filePath) === dir && /^index\.[cm]?[jt]sx?$/.test(posix.basename(file.filePath))
    );
    if (barrel && barrel.filePath !== resolved) return barrel.filePath;
    if (dir === "" || dir === ".") return null;
    dir = posix.dirname(dir);
  }
}

const TSCONFIG_BASENAME_PATTERN = /^tsconfig.*\.json$/;
const ALIAS_OPTION_PATTERN = /"(paths|baseUrl)"\s*:/;

function aliasConfigured(projectFiles: ProjectFile[]): boolean {
  return projectFiles.some((file) =>
    TSCONFIG_BASENAME_PATTERN.test(posix.basename(file.filePath))
    && ALIAS_OPTION_PATTERN.test(file.source)
  );
}

function medianClimb(projectFiles: ProjectFile[]): number {
  const climbs: number[] = [];
  const graph = buildModuleGraph(projectFiles);
  for (const [from, specifiers] of graph.specifiers) {
    for (const specifier of specifiers) {
      if (!specifier.startsWith(".")) continue;
      const levels = climbLevels(specifier);
      if (levels === 0) continue;
      const resolved = resolveModule(from, specifier, projectFiles);
      if (!resolved) continue;
      climbs.push(levels);
    }
  }
  if (climbs.length === 0) return 0;
  climbs.sort((left, right) => left - right);
  return climbs[Math.floor(climbs.length / 2)] ?? 0;
}

export function buildSkippedLevelImportEvidence(
  candidate: Candidate,
  projectFiles: ProjectFile[],
  changes: SourceFile[] = [],
): SkippedLevelImportEvidence | undefined {
  if (candidate.kind !== "module") return undefined;
  const module = buildModuleEvidence(candidate.filePath, changes, projectFiles);
  if (!module) return undefined;

  const owner = projectFiles.find((file) => file.filePath === candidate.filePath);
  if (!owner) return undefined;
  const change = changes.find((item) => item.filePath === candidate.filePath);
  const previous = previousSpecifiers(candidate.filePath, change?.oldSource ?? null);
  if (!previous) return undefined;

  const aliasAvailable = aliasConfigured(projectFiles);
  const climbs: SkippedLevelImportEvidence["climbs"] = [];
  for (const edge of module.importEdgesOut) {
    if (edge.resolved === null) continue;
    if (previous.has(edge.to)) continue;
    const levels = climbLevels(edge.to);
    if (levels < 2) continue;
    const barrel = nearestBarrel(edge.resolved, projectFiles);
    climbs.push({
      specifier: edge.to,
      levels,
      resolved: edge.resolved,
      alternative: barrel ? { kind: "barrel", path: barrel } : aliasAvailable ? { kind: "alias" } : null,
    });
    if (climbs.length >= MAX_CLIMB_DETAILS) break;
  }
  if (climbs.length === 0) return undefined;

  return {
    module,
    climbs,
    repoTypicalClimb: medianClimb(projectFiles),
    aliasAvailable,
  };
}
