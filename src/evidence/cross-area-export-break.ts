import type { Candidate, ProjectFile, SourceFile } from "../types.js";
import {
  buildModuleEvidence,
  isTestFile,
  moduleExportNames,
  parseProgram,
  topDirOf,
} from "./module.js";
import type { ModuleEvidence } from "./module.js";

const MAX_GROUPS = 12;
const MAX_IMPORTERS_PER_GROUP = 6;

export type BrokenAreaExport = {
  exportName: string;
  barrelReExported: boolean;
};

export type AreaImporterGroup = {
  area: string;
  importerCount: number;
  runtimeImporters: string[];
  testImporters: string[];
  updatedInSameDiff: string[];
};

export type CrossAreaExportBreakEvidence = {
  module: ModuleEvidence;
  removedExports: BrokenAreaExport[];
  areas: AreaImporterGroup[];
  distinctAreas: number;
  runtimeAreaCount: number;
};

function exportSet(filePath: string, source: string | null): Set<string> | undefined {
  if (source === null) return new Set();
  const program = parseProgram(filePath, source);
  if (!program) return undefined;
  return new Set(moduleExportNames(program));
}

export function buildCrossAreaExportBreakEvidence(
  candidate: Candidate,
  projectFiles: ProjectFile[],
  changes: SourceFile[] = [],
): CrossAreaExportBreakEvidence | undefined {
  if (candidate.kind !== "module") return undefined;
  const module = buildModuleEvidence(candidate.filePath, changes, projectFiles);
  if (!module) return undefined;

  const owner = projectFiles.find((file) => file.filePath === candidate.filePath);
  if (!owner) return undefined;
  const change = changes.find((item) => item.filePath === candidate.filePath);
  if (!change || change.oldSource === null) return undefined;

  const before = exportSet(candidate.filePath, change.oldSource);
  const after = exportSet(candidate.filePath, owner.source);
  if (!before || !after) return undefined;
  const removed = [...before].filter((name) => !after.has(name));
  if (removed.length === 0) return undefined;
  if (module.importEdgesIn.length === 0) return undefined;

  const offered = new Set(module.barrel.reExports.flatMap(({ symbols }) => symbols));
  const removedExports: BrokenAreaExport[] = removed.sort().map((exportName) => ({
    exportName,
    barrelReExported: module.barrel.reExportsSelf
      && (offered.has(exportName) || offered.has("*")),
  }));

  const changedPaths = new Set(changes.map((item) => item.filePath));
  const byArea = new Map<string, AreaImporterGroup>();
  for (const edge of module.importEdgesIn) {
    const area = topDirOf(edge.from);
    let group = byArea.get(area);
    if (!group) {
      group = {
        area,
        importerCount: 0,
        runtimeImporters: [],
        testImporters: [],
        updatedInSameDiff: [],
      };
      byArea.set(area, group);
    }
    group.importerCount += 1;
    if (isTestFile(edge.from)) {
      if (group.testImporters.length < MAX_IMPORTERS_PER_GROUP) group.testImporters.push(edge.from);
    } else if (group.runtimeImporters.length < MAX_IMPORTERS_PER_GROUP) {
      group.runtimeImporters.push(edge.from);
    }
    if (changedPaths.has(edge.from) && !group.updatedInSameDiff.includes(edge.from)) {
      group.updatedInSameDiff.push(edge.from);
    }
  }
  const areas = [...byArea.values()]
    .sort((left, right) => right.importerCount - left.importerCount || left.area.localeCompare(right.area))
    .slice(0, MAX_GROUPS);

  return {
    module,
    removedExports,
    areas,
    distinctAreas: byArea.size,
    runtimeAreaCount: areas.filter((group) => group.runtimeImporters.length > 0).length,
  };
}
