import type { Candidate, ProjectFile, SourceFile } from "../types.js";
import {
  buildModuleEvidence,
  dirOf,
  isFrameworkScaffolded,
  parseProgram,
  topDirOf,
} from "./module.js";
import type { ModuleEvidence } from "./module.js";
import { moduleImports, resolveModule } from "./repository.js";

export type DirectionReversingEdgeEvidence = {
  module: ModuleEvidence;
  newEdge: {
    specifier: string;
    resolved: string;
    targetArea: string;
  };
  incoming: {
    count: number;
    files: string[];
  };
  siblingIncoming: number;
  priorOutboundToArea: number;
  cycleClosed: boolean;
};

const SIBLING_SCAN_CAP = 20;
const REACH_DEPTH = 3;

function previousSpecifiers(filePath: string, oldSource: string | null): Set<string> | undefined {
  if (oldSource === null) return new Set();
  const program = parseProgram(filePath, oldSource);
  if (!program) return undefined;
  return new Set(moduleImports(program).map((item) => item.source));
}

function reachesTarget(
  from: string,
  goal: string,
  projectFiles: ProjectFile[],
  visited: Set<string>,
  depth: number,
): boolean {
  if (depth > REACH_DEPTH) return false;
  const file = projectFiles.find((item) => item.filePath === from);
  if (!file) return false;
  const program = parseProgram(file.filePath, file.source);
  if (!program) return false;
  for (const imported of moduleImports(program)) {
    const resolved = resolveModule(from, imported.source, projectFiles);
    if (!resolved || resolved.filePath === from) continue;
    if (resolved.filePath === goal) return true;
    if (visited.has(resolved.filePath)) continue;
    visited.add(resolved.filePath);
    if (reachesTarget(resolved.filePath, goal, projectFiles, visited, depth + 1)) return true;
  }
  return false;
}

function siblingIncomingCount(
  candidatePath: string,
  targetArea: string,
  projectFiles: ProjectFile[],
): number {
  const ownerDir = dirOf(candidatePath);
  const siblings = projectFiles
    .filter((file) => file.filePath !== candidatePath && dirOf(file.filePath) === ownerDir)
    .slice(0, SIBLING_SCAN_CAP);
  const hitting = new Set<string>();
  for (const sibling of siblings) {
    const program = parseProgram(sibling.filePath, sibling.source);
    if (!program) continue;
    for (const imported of moduleImports(program)) {
      const resolved = resolveModule(sibling.filePath, imported.source, projectFiles);
      if (resolved && topDirOf(resolved.filePath) === targetArea) {
        hitting.add(sibling.filePath);
        break;
      }
    }
  }
  return hitting.size;
}

export function buildDirectionReversingEdgeEvidence(
  candidate: Candidate,
  projectFiles: ProjectFile[],
  changes: SourceFile[] = [],
): DirectionReversingEdgeEvidence | undefined {
  if (candidate.kind !== "module") return undefined;
  if (isFrameworkScaffolded(candidate.filePath)) return undefined;
  const module = buildModuleEvidence(candidate.filePath, changes, projectFiles);
  if (!module) return undefined;

  const owner = projectFiles.find((file) => file.filePath === candidate.filePath);
  if (!owner) return undefined;
  const change = changes.find((item) => item.filePath === candidate.filePath);
  const previous = previousSpecifiers(candidate.filePath, change?.oldSource ?? null);
  if (!previous) return undefined;

  const ownerTopDir = topDirOf(candidate.filePath);
  const ranked: DirectionReversingEdgeEvidence[] = [];
  for (const edge of module.importEdgesOut) {
    if (edge.resolved === null) continue;
    if (previous.has(edge.to)) continue;
    if (edge.resolved === candidate.filePath) continue;
    const targetArea = topDirOf(edge.resolved);
    if (targetArea === "" || targetArea === ownerTopDir) continue;
    if (reachesTarget(edge.resolved, candidate.filePath, projectFiles, new Set([edge.resolved]), 1)) {
      continue;
    }

    const incomingFiles = [
      ...new Set(
        module.importEdgesIn
          .filter((incoming) => topDirOf(incoming.from) === targetArea)
          .map((incoming) => incoming.from),
      ),
    ].sort();
    const siblingIncoming = siblingIncomingCount(candidate.filePath, targetArea, projectFiles);
    if (incomingFiles.length + siblingIncoming < 2) continue;

    let priorOutboundToArea = 0;
    for (const specifier of previous) {
      const resolved = resolveModule(candidate.filePath, specifier, projectFiles);
      if (resolved && topDirOf(resolved.filePath) === targetArea) priorOutboundToArea += 1;
    }

    ranked.push({
      module,
      newEdge: { specifier: edge.to, resolved: edge.resolved, targetArea },
      incoming: { count: incomingFiles.length, files: incomingFiles.slice(0, 10) },
      siblingIncoming,
      priorOutboundToArea,
      cycleClosed: false,
    });
  }
  ranked.sort((left, right) =>
    right.incoming.count + right.siblingIncoming - (left.incoming.count + left.siblingIncoming)
    || left.newEdge.resolved.localeCompare(right.newEdge.resolved),
  );
  return ranked[0];
}
