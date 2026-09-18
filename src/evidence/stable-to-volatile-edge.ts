import type { Candidate, ProjectFile, SourceFile } from "../types.js";
import {
  buildModuleEvidence,
  buildModuleGraph,
  edgesIn,
  isTestFile,
  parseProgram,
  topDirOf,
} from "./module.js";
import type { ModuleEvidence } from "./module.js";
import { moduleImports } from "./repository.js";

const MAX_NEW_EDGES = 8;
const MAX_EXTERNAL = 8;

const FIXTURE_SEGMENT_PATTERN = /(^|\/)(__fixtures__|fixtures|mocks|__mocks__)(\/|$)/;
const INTERNAL_PATH_PATTERN = /(^|\/)(internal|_internal|private)(\/|$)/;

export type VolatileTargetEdge = {
  specifier: string;
  resolved: string;
  targetTopDir: string;
  targetImporters: number;
  targetImporterAreas: number;
  zeroImporters: boolean;
  testMarked: boolean;
  fixtureMarked: boolean;
  internalMarked: boolean;
  newlyAdded: boolean;
  typeOnly: boolean;
};

export type StableToVolatileEdgeEvidence = {
  module: ModuleEvidence;
  ownerImporters: number;
  ownerImporterAreas: number;
  newEdges: VolatileTargetEdge[];
  externalAdded: string[];
};

function previousSpecifiers(filePath: string, oldSource: string | null): Set<string> | undefined {
  if (oldSource === null) return new Set();
  const program = parseProgram(filePath, oldSource);
  if (!program) return undefined;
  return new Set(moduleImports(program).map((item) => item.source));
}

export function buildStableToVolatileEdgeEvidence(
  candidate: Candidate,
  projectFiles: ProjectFile[],
  changes: SourceFile[] = [],
): StableToVolatileEdgeEvidence | undefined {
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

  const graph = buildModuleGraph(projectFiles);
  const addedFiles = new Set(
    changes.filter((item) => item.oldSource === null).map((item) => item.filePath),
  );
  const byPath = new Map(projectFiles.map((file) => [file.filePath, file]));

  const newEdges: VolatileTargetEdge[] = [];
  const externalAdded: string[] = [];
  for (const edge of module.importEdgesOut) {
    if (previous.has(edge.to)) continue;
    if (edge.resolved === null) {
      if (externalAdded.length < MAX_EXTERNAL) externalAdded.push(edge.to);
      continue;
    }
    if (newEdges.length >= MAX_NEW_EDGES) break;
    const target = byPath.get(edge.resolved);
    const incoming = edgesIn(edge.resolved, graph, projectFiles).edges.filter(
      (item) => item.from !== candidate.filePath,
    );
    const importerAreas = new Set(incoming.map((item) => topDirOf(item.from)));
    newEdges.push({
      specifier: edge.to,
      resolved: edge.resolved,
      targetTopDir: topDirOf(edge.resolved),
      targetImporters: incoming.length,
      targetImporterAreas: importerAreas.size,
      zeroImporters: incoming.length === 0,
      testMarked: isTestFile(edge.resolved, projectFiles),
      fixtureMarked: FIXTURE_SEGMENT_PATTERN.test(edge.resolved),
      internalMarked: INTERNAL_PATH_PATTERN.test(edge.resolved)
        || (target ? /@internal\b/.test(target.source) : false),
      newlyAdded: addedFiles.has(edge.resolved),
      typeOnly: typeOnlySources.has(edge.to),
    });
  }
  if (newEdges.length === 0) return undefined;

  return {
    module,
    ownerImporters: module.importEdgesIn.length,
    ownerImporterAreas: new Set(module.importEdgesIn.map((edge) => topDirOf(edge.from))).size,
    newEdges,
    externalAdded,
  };
}
