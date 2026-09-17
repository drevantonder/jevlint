import { posix } from "node:path";
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
import {
  findModuleImporters,
  manifestDependencies,
  moduleImports,
  resolveModule,
} from "./repository.js";

export type TwinGatewayEvidence = {
  module: ModuleEvidence;
  dependency: string;
  specifier: string;
  declared: boolean;
  gateways: {
    path: string;
    area: string;
    importerCount: number;
    domainExports: string[];
  }[];
  reuseOneEdgeAway: boolean;
  usedSymbols: string[];
};

const GENERIC_EXPORT_PATTERN =
  /(Util|Utils|Helper|Helpers|Config|Configs|Test|Spec|Mock|Mocks|Fixture|Fixtures|Schema|Types?|Options|Props|Params|Errors?)$/;

const MAX_GATEWAYS = 6;

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

function dependencyRoot(specifier: string): string | undefined {
  if (specifier.startsWith(".") || specifier.startsWith("/") || specifier.startsWith("#")) {
    return undefined;
  }
  if (specifier.startsWith("node:")) return undefined;
  const segments = specifier.split("/");
  const first = segments[0];
  if (!first) return undefined;
  if (first.startsWith("@")) {
    const second = segments[1];
    if (!second) return undefined;
    return `${first}/${second}`;
  }
  return first;
}

function entityLikeExports(filePath: string, source: string): string[] {
  const program = parseProgram(filePath, source);
  if (!program) return [];
  return moduleExportNames(program)
    .filter((name) => /^[A-Z][A-Za-z0-9]*$/.test(name) && !GENERIC_EXPORT_PATTERN.test(name))
    .sort()
    .slice(0, 8);
}

export function buildTwinGatewayEmergenceEvidence(
  candidate: Candidate,
  projectFiles: ProjectFile[],
  changes: SourceFile[] = [],
): TwinGatewayEvidence | undefined {
  if (candidate.kind !== "module") return undefined;
  if (isFrameworkScaffolded(candidate.filePath)) return undefined;
  const module = buildModuleEvidence(candidate.filePath, changes, projectFiles);
  if (!module) return undefined;

  const owner = projectFiles.find((file) => file.filePath === candidate.filePath);
  if (!owner) return undefined;
  const change = changes.find((item) => item.filePath === candidate.filePath);
  const previous = previousSpecifiers(candidate.filePath, change?.oldSource ?? null);
  if (!previous) return undefined;

  const declaredDeps = new Set<string>();
  for (const file of projectFiles) {
    if (posix.basename(file.filePath) !== "package.json") continue;
    for (const dep of manifestDependencies(file.source)) declaredDeps.add(dep.name);
  }

  const ownerTopDir = topDirOf(candidate.filePath);
  const ranked: TwinGatewayEvidence[] = [];
  for (const edge of module.importEdgesOut) {
    if (edge.resolved !== null) continue;
    if (previous.has(edge.to)) continue;
    const root = dependencyRoot(edge.to);
    if (!root) continue;

    const gatewayPaths = new Set<string>();
    for (const file of projectFiles) {
      if (file.filePath === candidate.filePath) continue;
      if (isTestFile(file.filePath)) continue;
      if (topDirOf(file.filePath) === ownerTopDir) continue;
      const program = parseProgram(file.filePath, file.source);
      if (!program) continue;
      for (const imported of moduleImports(program)) {
        if (dependencyRoot(imported.source) === root) {
          gatewayPaths.add(file.filePath);
          break;
        }
      }
    }
    if (gatewayPaths.size === 0) continue;

    const gateways = [...gatewayPaths]
      .sort()
      .slice(0, MAX_GATEWAYS)
      .map((path) => {
        const gateway = projectFiles.find((file) => file.filePath === path);
        return {
          path,
          area: topDirOf(path),
          importerCount: findModuleImporters(path, projectFiles).length,
          domainExports: gateway ? entityLikeExports(gateway.filePath, gateway.source) : [],
        };
      });

    let reuseOneEdgeAway = false;
    for (const file of projectFiles) {
      if (topDirOf(file.filePath) !== ownerTopDir) continue;
      if (file.filePath === candidate.filePath) continue;
      const program = parseProgram(file.filePath, file.source);
      if (!program) continue;
      for (const imported of moduleImports(program)) {
        const resolved = resolveModule(file.filePath, imported.source, projectFiles);
        if (resolved && gatewayPaths.has(resolved.filePath)) {
          reuseOneEdgeAway = true;
          break;
        }
      }
      if (reuseOneEdgeAway) break;
    }

    ranked.push({
      module,
      dependency: root,
      specifier: edge.to,
      declared: declaredDeps.has(root),
      gateways,
      reuseOneEdgeAway,
      usedSymbols: importedSymbolsOf(candidate.filePath, owner.source, edge.to),
    });
  }
  ranked.sort((left, right) => left.dependency.localeCompare(right.dependency));
  return ranked[0];
}
