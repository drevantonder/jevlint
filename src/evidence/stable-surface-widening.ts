import type { Candidate, ProjectFile, SourceFile } from "../types.js";
import {
  buildModuleEvidence,
  isFrameworkScaffolded,
  isTestFile,
  moduleExportNames,
  parseProgram,
  topDirOf,
} from "./module.js";
import type { ModuleEvidence } from "./module.js";

export type AddedExport = {
  name: string;
  kind: "concept" | "utility";
};

export type StableSurfaceWideningEvidence = {
  module: ModuleEvidence;
  addedExports: AddedExport[];
  totalImporters: number;
  distinctAreas: number;
  importerAreas: { area: string; importers: string[] }[];
  runtimeImporters: number;
  testImporters: number;
  barrelReExportsNew: string[];
  barrelTruncated: boolean;
  testMarked: boolean;
};

const UTILITY_NAME_PATTERN = /(util|utils|helper|helpers|format|parse|serial|valid|normal|convert|misc|common|shared|tool|tools)/i;
const MAX_IMPORTERS_PER_AREA = 8;
const MAX_AREAS = 10;

function exportSet(filePath: string, source: string): Set<string> | undefined {
  const program = parseProgram(filePath, source);
  if (!program) return undefined;
  return new Set(moduleExportNames(program));
}

function classifyAdded(name: string): "concept" | "utility" {
  return UTILITY_NAME_PATTERN.test(name) ? "utility" : "concept";
}

export function buildStableSurfaceWideningEvidence(
  candidate: Candidate,
  projectFiles: ProjectFile[],
  changes: SourceFile[] = [],
): StableSurfaceWideningEvidence | undefined {
  if (candidate.kind !== "module") return undefined;
  if (isFrameworkScaffolded(candidate.filePath)) return undefined;
  const module = buildModuleEvidence(candidate.filePath, changes, projectFiles);
  if (!module) return undefined;

  const change = changes.find((item) => item.filePath === candidate.filePath);
  if (!change || change.oldSource === null) return undefined;
  const before = exportSet(candidate.filePath, change.oldSource);
  const owner = projectFiles.find((file) => file.filePath === candidate.filePath);
  if (!before || !owner) return undefined;
  const after = exportSet(candidate.filePath, owner.source);
  if (!after) return undefined;

  const removed = [...before].filter((name) => !after.has(name));
  if (removed.length > 0) return undefined;
  const added = [...after].filter((name) => !before.has(name)).sort();
  if (added.length === 0) return undefined;

  const byArea = new Map<string, string[]>();
  let runtimeImporters = 0;
  let testImporters = 0;
  for (const edge of module.importEdgesIn) {
    if (isTestFile(edge.from, projectFiles)) testImporters += 1;
    else runtimeImporters += 1;
    const area = topDirOf(edge.from) || "(root)";
    const list = byArea.get(area) ?? [];
    if (list.length < MAX_IMPORTERS_PER_AREA && !list.includes(edge.from)) list.push(edge.from);
    byArea.set(area, list);
  }
  const importerAreas = [...byArea.entries()]
    .map(([area, importers]) => ({ area, importers: [...importers].sort() }))
    .sort((left, right) => left.area.localeCompare(right.area))
    .slice(0, MAX_AREAS);

  const offered = new Set(module.barrel.reExports.flatMap(({ symbols }) => symbols));
  const barrelReExportsNew = module.barrel.reExportsTruncated
    ? []
    : added.filter((name) => offered.has(name) || offered.has("*"));

  return {
    module,
    addedExports: added.map((name) => ({ name, kind: classifyAdded(name) })),
    totalImporters: module.importEdgesIn.length,
    distinctAreas: byArea.size,
    importerAreas,
    runtimeImporters,
    testImporters,
    barrelReExportsNew,
    barrelTruncated: module.barrel.reExportsTruncated,
    testMarked: isTestFile(candidate.filePath, projectFiles),
  };
}
