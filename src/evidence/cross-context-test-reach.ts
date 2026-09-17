import type { Candidate, ProjectFile, SourceFile } from "../types.js";
import {
  buildModuleEvidence,
  isFrameworkScaffolded,
  isTestFile,
  parseProgram,
  topDirOf,
} from "./module.js";
import type { ModuleEvidence } from "./module.js";
import { findModuleImporters, moduleImports } from "./repository.js";

export type CrossContextTestReachEvidence = {
  module: ModuleEvidence;
  target: string;
  specifier: string;
  testMarkers: {
    testFile: boolean;
    fixtureSegment: boolean;
  };
  valueImport: boolean;
  usedSymbols: string[];
  crossAreaImporters: string[];
};

const FIXTURE_SEGMENT_PATTERN = /(^|\/)(__fixtures__|fixtures|__mocks__|mocks)(\/|$)/;

function previousSpecifiers(filePath: string, oldSource: string | null): Set<string> | undefined {
  if (oldSource === null) return new Set();
  const program = parseProgram(filePath, oldSource);
  if (!program) return undefined;
  return new Set(moduleImports(program).map((item) => item.source));
}

function valueImportOf(filePath: string, source: string, specifier: string): boolean {
  const program = parseProgram(filePath, source);
  if (!program) return false;
  for (const statement of program.body) {
    if (statement.type !== "ImportDeclaration") continue;
    if (statement.source.value !== specifier) continue;
    if (statement.importKind !== "type") return true;
  }
  return false;
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

export function buildCrossContextTestReachEvidence(
  candidate: Candidate,
  projectFiles: ProjectFile[],
  changes: SourceFile[] = [],
): CrossContextTestReachEvidence | undefined {
  if (candidate.kind !== "module") return undefined;
  if (isFrameworkScaffolded(candidate.filePath)) return undefined;
  if (isTestFile(candidate.filePath)) return undefined;
  const module = buildModuleEvidence(candidate.filePath, changes, projectFiles);
  if (!module) return undefined;

  const owner = projectFiles.find((file) => file.filePath === candidate.filePath);
  if (!owner) return undefined;
  const change = changes.find((item) => item.filePath === candidate.filePath);
  const previous = previousSpecifiers(candidate.filePath, change?.oldSource ?? null);
  if (!previous) return undefined;

  const ownerTopDir = topDirOf(candidate.filePath);
  const ranked: CrossContextTestReachEvidence[] = [];
  for (const edge of module.importEdgesOut) {
    if (edge.resolved === null) continue;
    if (previous.has(edge.to)) continue;
    if (edge.resolved === candidate.filePath) continue;
    const testFile = isTestFile(edge.resolved);
    const fixtureSegment = FIXTURE_SEGMENT_PATTERN.test(edge.resolved);
    if (!testFile && !fixtureSegment) continue;
    const targetArea = topDirOf(edge.resolved);
    if (targetArea === "" || targetArea === ownerTopDir) continue;

    const crossAreaImporters = findModuleImporters(edge.resolved, projectFiles)
      .map((importer) => importer.filePath)
      .filter((path) => path !== candidate.filePath && topDirOf(path) !== ownerTopDir)
      .sort()
      .slice(0, 8);

    ranked.push({
      module,
      target: edge.resolved,
      specifier: edge.to,
      testMarkers: { testFile, fixtureSegment },
      valueImport: valueImportOf(candidate.filePath, owner.source, edge.to),
      usedSymbols: importedSymbolsOf(candidate.filePath, owner.source, edge.to),
      crossAreaImporters,
    });
  }
  ranked.sort((left, right) => left.target.localeCompare(right.target));
  return ranked[0];
}
