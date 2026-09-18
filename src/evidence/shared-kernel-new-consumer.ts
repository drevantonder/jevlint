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
import { findModuleImporters, moduleImports } from "./repository.js";

export type SharedKernelConsumerEvidence = {
  module: ModuleEvidence;
  target: string;
  specifier: string;
  kernelMarkers: {
    sharedSegment: boolean;
    domainExports: string[];
    genericTarget: boolean;
  };
  entrenchment: {
    importerCount: number;
    distinctAreas: string[];
  };
  usedSymbols: string[];
};

const GENERIC_EXPORT_PATTERN =
  /(Util|Utils|Helper|Helpers|Config|Configs|Test|Spec|Mock|Mocks|Fixture|Fixtures|Schema|Types?|Options|Props|Params|Errors?)$/;

function entityLikeExports(filePath: string, source: string): string[] {
  const program = parseProgram(filePath, source);
  if (!program) return [];
  return moduleExportNames(program)
    .filter((name) => /^[A-Z][A-Za-z0-9]*$/.test(name) && !GENERIC_EXPORT_PATTERN.test(name))
    .sort()
    .slice(0, 12);
}

function previousSpecifiers(filePath: string, oldSource: string | null): Set<string> | undefined {
  if (oldSource === null) return new Set();
  const program = parseProgram(filePath, oldSource);
  if (!program) return undefined;
  return new Set(moduleImports(program).map((item) => item.source));
}

function importedSymbolsOf(filePath: string, source: string, specifier: string): string[] {
  const program = parseProgram(filePath, source);
  if (!program) return [];
  const symbols = new Set<string>();
  for (const imported of moduleImports(program)) {
    if (imported.source !== specifier) continue;
    symbols.add(imported.imported);
  }
  return [...symbols].sort();
}

function hasSharedSegment(filePath: string): boolean {
  return filePath
    .toLowerCase()
    .split("/")
    .some((segment) => segment === "shared" || segment === "common");
}

export function buildSharedKernelNewConsumerEvidence(
  candidate: Candidate,
  projectFiles: ProjectFile[],
  changes: SourceFile[] = [],
): SharedKernelConsumerEvidence | undefined {
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
  const ranked: SharedKernelConsumerEvidence[] = [];
  for (const edge of module.importEdgesOut) {
    if (edge.resolved === null) continue;
    if (previous.has(edge.to)) continue;
    if (edge.resolved === candidate.filePath) continue;
    if (isTestFile(edge.resolved, projectFiles)) continue;
    if (topDirOf(edge.resolved) === ownerTopDir) continue;
    if (!hasSharedSegment(edge.resolved)) continue;

    const target = projectFiles.find((file) => file.filePath === edge.resolved);
    if (!target) continue;
    const domainExports = entityLikeExports(target.filePath, target.source);
    const importers = findModuleImporters(edge.resolved, projectFiles)
      .filter((importer) => importer.filePath !== candidate.filePath);
    if (importers.some((importer) => topDirOf(importer.filePath) === ownerTopDir)) continue;

    const areas = [...new Set(importers.map((importer) => topDirOf(importer.filePath)))].sort();
    ranked.push({
      module,
      target: edge.resolved,
      specifier: edge.to,
      kernelMarkers: {
        sharedSegment: true,
        domainExports,
        genericTarget: domainExports.length === 0,
      },
      entrenchment: {
        importerCount: importers.length,
        distinctAreas: areas,
      },
      usedSymbols: importedSymbolsOf(candidate.filePath, owner.source, edge.to),
    });
  }
  ranked.sort(
    (left, right) =>
      right.entrenchment.distinctAreas.length - left.entrenchment.distinctAreas.length
      || right.entrenchment.importerCount - left.entrenchment.importerCount
      || left.target.localeCompare(right.target),
  );
  return ranked[0];
}
