import type { Candidate, ProjectFile, SourceFile } from "../types.js";
import {
  buildModuleEvidence,
  dirOf,
  inferLayer,
  parseProgram,
  topDirOf,
} from "./module.js";
import type { ModuleEvidence } from "./module.js";
import { moduleImports, resolveModule } from "./repository.js";

const MAX_NEW_EDGES = 12;

export type NewAreaEdge = {
  specifier: string;
  resolved: string | null;
  external: boolean;
  crossesTopDir: boolean;
  targetTopDir: string;
  targetRole: string;
  typeOnly: boolean;
};

export type EfferentCouplingBurstEvidence = {
  module: ModuleEvidence;
  newEdges: NewAreaEdge[];
  distinctNewAreas: number;
  beforeAreas: number;
  afterAreas: number;
  featureGrouping: string;
};

function previousSpecifiers(filePath: string, oldSource: string | null): Set<string> | undefined {
  if (oldSource === null) return new Set();
  const program = parseProgram(filePath, oldSource);
  if (!program) return undefined;
  return new Set(moduleImports(program).map((item) => item.source));
}

function resolvedTopDirs(
  filePath: string,
  specifiers: Set<string>,
  projectFiles: ProjectFile[],
): Set<string> {
  const areas = new Set<string>();
  for (const specifier of specifiers) {
    const resolved = resolveModule(filePath, specifier, projectFiles);
    if (!resolved) continue;
    areas.add(topDirOf(resolved.filePath));
  }
  return areas;
}

export function buildEfferentCouplingBurstEvidence(
  candidate: Candidate,
  projectFiles: ProjectFile[],
  changes: SourceFile[] = [],
): EfferentCouplingBurstEvidence | undefined {
  if (candidate.kind !== "module") return undefined;
  const module = buildModuleEvidence(candidate.filePath, changes, projectFiles);
  if (!module) return undefined;

  const owner = projectFiles.find((file) => file.filePath === candidate.filePath);
  if (!owner) return undefined;
  const change = changes.find((item) => item.filePath === candidate.filePath);
  const previous = previousSpecifiers(candidate.filePath, change?.oldSource ?? null);
  if (!previous) return undefined;
  const program = parseProgram(owner.filePath, owner.source);
  if (!program) return undefined;

  const typeOnlySources = new Set<string>();
  for (const statement of program.body) {
    if (statement.type === "ImportDeclaration" && statement.importKind === "type") {
      typeOnlySources.add(statement.source.value);
    }
  }

  const newEdges: NewAreaEdge[] = [];
  for (const edge of module.importEdgesOut) {
    if (previous.has(edge.to)) continue;
    const resolved = edge.resolved;
    newEdges.push({
      specifier: edge.to,
      resolved,
      external: resolved === null,
      crossesTopDir: edge.crossesTopDir,
      targetTopDir: resolved ? topDirOf(resolved) : "",
      targetRole: resolved ? inferLayer(dirOf(resolved)).inferredRole : "unknown",
      typeOnly: typeOnlySources.has(edge.to),
    });
    if (newEdges.length >= MAX_NEW_EDGES) break;
  }
  if (newEdges.length === 0) return undefined;

  const current = new Set(module.importEdgesOut.map((edge) => edge.to));
  const beforeAreas = resolvedTopDirs(candidate.filePath, previous, projectFiles);
  const afterAreas = resolvedTopDirs(candidate.filePath, current, projectFiles);
  const distinctNewAreas = new Set(
    newEdges.filter((edge) => edge.resolved !== null).map((edge) => edge.targetTopDir),
  );

  return {
    module,
    newEdges,
    distinctNewAreas: distinctNewAreas.size,
    beforeAreas: beforeAreas.size,
    afterAreas: afterAreas.size,
    featureGrouping: module.repoNorms.featureGrouping.value,
  };
}
