import type { Candidate, ProjectFile, SourceFile } from "../types.js";
import {
  barrelReExports,
  buildModuleEvidence,
  dirOf,
  isFrameworkScaffolded,
  parseProgram,
} from "./module.js";
import type { ModuleEvidence } from "./module.js";
import { moduleImports, resolveModule } from "./repository.js";

export type BarrelBypassEvidence = {
  module: ModuleEvidence;
  bypass: {
    specifier: string;
    resolved: string;
    importedSymbols: string[];
    barrel: string;
    barrelReExports: string[];
  }[];
  adoption: {
    externalImporters: number;
    viaBarrel: number;
    ratio: number;
  };
};

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

function previousSpecifiers(filePath: string, oldSource: string | null): Set<string> | undefined {
  if (oldSource === null) return new Set();
  const program = parseProgram(filePath, oldSource);
  if (!program) return undefined;
  return new Set(moduleImports(program).map((item) => item.source));
}

export function buildBarrelBypassEvidence(
  candidate: Candidate,
  projectFiles: ProjectFile[],
  changes: SourceFile[] = [],
): BarrelBypassEvidence | undefined {
  if (candidate.kind !== "module") return undefined;
  if (isFrameworkScaffolded(candidate.filePath)) return undefined;
  const module = buildModuleEvidence(candidate.filePath, changes, projectFiles);
  if (!module) return undefined;
  if (module.barrel.reExportsTruncated) return undefined;

  const owner = projectFiles.find((file) => file.filePath === candidate.filePath);
  if (!owner) return undefined;
  const change = changes.find((item) => item.filePath === candidate.filePath);
  const previous = previousSpecifiers(candidate.filePath, change?.oldSource ?? null);
  if (!previous) return undefined;

  const bypass: BarrelBypassEvidence["bypass"] = [];
  for (const edge of module.importEdgesOut) {
    if (edge.resolved === null) continue;
    if (previous.has(edge.to)) continue;
    if (edge.resolved === candidate.filePath) continue;
    const targetDir = dirOf(edge.resolved);
    if (targetDir === dirOf(candidate.filePath)) continue;
    if (targetDir === "") continue;
    const barrelPath = projectFiles.find((file) =>
      dirOf(file.filePath) === targetDir && /^index\.[cm]?[jt]sx?$/.test(file.filePath.split("/").pop() ?? "")
    );
    if (!barrelPath) continue;
    if (edge.resolved === barrelPath.filePath) continue;
    const symbols = importedSymbolsOf(candidate.filePath, owner.source, edge.to);
    const reExports = barrelReExports(barrelPath);
    const offered = new Set(reExports.flatMap(({ symbols: names }) => names));
    const covered = symbols.length === 0
      ? offered.size > 0
      : symbols.some((symbol) => offered.has(symbol) || offered.has("*"));
    if (!covered) continue;
    bypass.push({
      specifier: edge.to,
      resolved: edge.resolved,
      importedSymbols: symbols,
      barrel: barrelPath.filePath,
      barrelReExports: [...offered].sort().slice(0, 30),
    });
  }
  if (bypass.length === 0) return undefined;

  let external = 0;
  let viaBarrel = 0;
  for (const file of projectFiles) {
    if (file.filePath === candidate.filePath) continue;
    const program = parseProgram(file.filePath, file.source);
    if (!program) continue;
    for (const imported of moduleImports(program)) {
      const resolved = resolveModule(file.filePath, imported.source, projectFiles);
      if (!resolved) continue;
      const hit = bypass.find(({ barrel, resolved: target }) =>
        resolved.filePath === barrel || resolved.filePath === target
      );
      if (!hit) continue;
      if (dirOf(file.filePath) === dirOf(hit.resolved)) continue;
      external += 1;
      if (resolved.filePath === hit.barrel) viaBarrel += 1;
      break;
    }
  }
  if (external < 2) return undefined;

  return {
    module,
    bypass,
    adoption: {
      externalImporters: external,
      viaBarrel,
      ratio: viaBarrel / external,
    },
  };
}
