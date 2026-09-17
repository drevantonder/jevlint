import { posix } from "node:path";
import type { Candidate, ProjectFile, SourceFile } from "../types.js";
import {
  buildModuleEvidence,
  buildModuleGraph,
  dirOf,
  fileSuffixProfile,
  isFrameworkScaffolded,
  isSourcePath,
  isTestFile,
  moduleExportNames,
  parseProgram,
  plainStem,
  topDirOf,
} from "./module.js";
import type { ModuleEvidence } from "./module.js";
import { resolveModule } from "./repository.js";

export type StemTwin = {
  filePath: string;
  exports: string[];
  sharedExports: string[];
  overlapRatio: number;
  testMarked: boolean;
  siblingSuffixes: Record<string, number>;
};

export type SameStemDivergentRoleEvidence = {
  module: ModuleEvidence;
  stem: string;
  candidateExports: string[];
  twins: StemTwin[];
  sharedClientAreas: string[];
  crossAreaImports: string[];
};

const MAX_TWINS = 6;

function exportNames(filePath: string, source: string): string[] | undefined {
  const program = parseProgram(filePath, source);
  if (!program) return undefined;
  return moduleExportNames(program);
}

function suffixEntries(dir: string, projectFiles: ProjectFile[]): [string, number][] {
  const counts = new Map<string, number>();
  for (const file of projectFiles) {
    if (!isSourcePath(file.filePath)) continue;
    if (dirOf(file.filePath) !== dir) continue;
    const suffix = fileSuffixProfile(posix.basename(file.filePath));
    counts.set(suffix, (counts.get(suffix) ?? 0) + 1);
  }
  return [...counts.entries()];
}

export function buildSameStemDivergentRoleEvidence(
  candidate: Candidate,
  projectFiles: ProjectFile[],
  changes: SourceFile[] = [],
): SameStemDivergentRoleEvidence | undefined {
  if (candidate.kind !== "module") return undefined;
  if (isFrameworkScaffolded(candidate.filePath)) return undefined;
  const module = buildModuleEvidence(candidate.filePath, changes, projectFiles);
  if (!module) return undefined;

  const owner = projectFiles.find((file) => file.filePath === candidate.filePath);
  if (!owner) return undefined;
  const candidateExports = exportNames(candidate.filePath, owner.source);
  if (!candidateExports || candidateExports.length === 0) return undefined;

  const change = changes.find((item) => item.filePath === candidate.filePath);
  if (change && change.oldSource !== null) {
    const before = exportNames(candidate.filePath, change.oldSource);
    if (!before) return undefined;
    const beforeSet = new Set(before);
    const afterSet = new Set(candidateExports);
    const changed = [...beforeSet].some((name) => !afterSet.has(name))
      || [...afterSet].some((name) => !beforeSet.has(name));
    if (!changed) return undefined;
  }

  const stem = plainStem(candidate.filePath);
  const ownerTop = topDirOf(candidate.filePath);
  const twins: StemTwin[] = [];
  for (const file of projectFiles) {
    if (twins.length >= MAX_TWINS) break;
    if (file.filePath === candidate.filePath) continue;
    if (!isSourcePath(file.filePath)) continue;
    if (plainStem(file.filePath) !== stem) continue;
    if (topDirOf(file.filePath) === ownerTop) continue;
    const twinExports = exportNames(file.filePath, file.source);
    if (!twinExports) continue;
    const shared = twinExports.filter((name) => candidateExports.includes(name));
    if (shared.length > 0) continue;
    const overlapRatio = twinExports.length === 0 && candidateExports.length === 0
      ? 0
      : shared.length / Math.max(candidateExports.length, twinExports.length);
    twins.push({
      filePath: file.filePath,
      exports: twinExports.slice(0, 20),
      sharedExports: shared,
      overlapRatio,
      testMarked: isTestFile(file.filePath),
      siblingSuffixes: Object.fromEntries(suffixEntries(dirOf(file.filePath), projectFiles)),
    });
  }
  if (twins.length === 0) return undefined;

  const twinPaths = new Set(twins.map((twin) => twin.filePath));
  const candidateClients = new Set<string>();
  const twinClients = new Map<string, Set<string>>();
  const graph = buildModuleGraph(projectFiles);
  for (const [from, specifiers] of graph.specifiers) {
    if (from === candidate.filePath || twinPaths.has(from)) continue;
    for (const specifier of specifiers) {
      const resolved = resolveModule(from, specifier, projectFiles);
      if (!resolved) continue;
      if (resolved.filePath === candidate.filePath) candidateClients.add(from);
      else if (twinPaths.has(resolved.filePath)) {
        let set = twinClients.get(resolved.filePath);
        if (!set) {
          set = new Set();
          twinClients.set(resolved.filePath, set);
        }
        set.add(from);
      }
    }
  }
  const candidateAreas = new Set([...candidateClients].map((path) => topDirOf(path)));
  const sharedClientAreas = new Set<string>();
  for (const clients of twinClients.values()) {
    for (const client of clients) {
      if (candidateAreas.has(topDirOf(client))) sharedClientAreas.add(topDirOf(client) || "(root)");
    }
  }

  const crossAreaImports: string[] = [];
  for (const twin of twins) {
    const twinTop = topDirOf(twin.filePath);
    const twinImportsOwnerArea = (graph.specifiers.get(twin.filePath) ?? []).some((specifier) => {
      const resolved = resolveModule(twin.filePath, specifier, projectFiles);
      return resolved !== undefined && topDirOf(resolved.filePath) === ownerTop;
    });
    const ownerImportsTwinArea = (graph.specifiers.get(candidate.filePath) ?? []).some((specifier) => {
      const resolved = resolveModule(candidate.filePath, specifier, projectFiles);
      return resolved !== undefined && topDirOf(resolved.filePath) === twinTop;
    });
    if (twinImportsOwnerArea) crossAreaImports.push(`${twin.filePath} imports ${ownerTop || "(root)"}`);
    if (ownerImportsTwinArea) crossAreaImports.push(`${candidate.filePath} imports ${twinTop || "(root)"}`);
  }

  return {
    module,
    stem,
    candidateExports: candidateExports.slice(0, 20),
    twins,
    sharedClientAreas: [...sharedClientAreas].sort(),
    crossAreaImports,
  };
}
