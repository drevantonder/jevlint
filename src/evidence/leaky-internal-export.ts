import { parseCached } from "./parse-cache.js";
import type { Candidate, ProjectFile } from "../types.js";
import {
  abstractionName,
  findDirectAbstraction,
  findModuleImporters,
  isAbstractionExported,
  resolveModule,
} from "./repository.js";
import type { ModuleImporter } from "./repository.js";

const MAX_REEXPORTS = 10;
const MAX_EXCERPT_CHARS = 500;

const INTERNAL_PATH_PATTERN = /(^|[/\\])(internal|_internal|private|_private|__tests__|__fixtures__|fixtures?|mocks?|test-helpers?|testing|__mocks__)([/\\]|$)/i;
const INTERNAL_FILE_PATTERN = /(^|[/\\])(internal|_private|_internal)[\w.-]*\.[cm]?[jt]sx?$|\.(test|spec|fixture|mock)\.[cm]?[jt]sx?$/i;
const INTERNAL_SYMBOL_PATTERN = /^_|internal/i;
const INTERNAL_DOC_PATTERN = /@internal\b|internal use only|do not import|private api/i;

export type BarrelReExport = {
  statement: string;
  target: string;
  internalMarkers: string[];
  leakedSymbols: string[];
};

export type InternalTargetNote = {
  filePath: string;
  documentsInternal: boolean;
  excerpt: string;
};

export type LeakyInternalExportEvidence = {
  abstraction: {
    name: string;
    exported: boolean;
    filePath: string;
    source: string;
    moduleSource: string;
  };
  barrel: {
    reExports: BarrelReExport[];
  };
  externalReach: ModuleImporter[];
  internalTargets: InternalTargetNote[];
};

function exportedName(specifier: { exported: { type: string; name?: string; value?: string } }): string {
  const exported = specifier.exported;
  if (exported.type === "Identifier" && exported.name) return exported.name;
  if (exported.value) return exported.value;
  return "unknown";
}

export function buildLeakyInternalExportEvidence(
  candidate: Candidate,
  projectFiles: ProjectFile[],
): LeakyInternalExportEvidence | undefined {
  if (candidate.kind !== "abstraction") return undefined;
  const owner = projectFiles.find((file) => file.filePath === candidate.filePath);
  if (!owner) return undefined;
  const parsed = parseCached(owner.filePath, owner.source);
  if (parsed.errors.some((error) => error.severity === "Error")) return undefined;
  const declaration = findDirectAbstraction(parsed.program, candidate);
  if (!declaration) return undefined;
  const name = abstractionName(parsed.program, declaration);

  const reExports: BarrelReExport[] = [];
  for (const statement of parsed.program.body) {
    if (reExports.length >= MAX_REEXPORTS) break;
    if (statement.type === "ExportAllDeclaration") {
      const target = statement.source.value;
      const markers: string[] = [];
      if (INTERNAL_PATH_PATTERN.test(target) || INTERNAL_FILE_PATTERN.test(target)) {
        markers.push(`internal path segment in ${JSON.stringify(target)}`);
      }
      reExports.push({
        statement: owner.source.slice(statement.start, statement.end).slice(0, MAX_EXCERPT_CHARS),
        target,
        internalMarkers: markers,
        leakedSymbols: ["*"],
      });
      continue;
    }
    if (statement.type === "ExportNamedDeclaration" && statement.source) {
      const target = statement.source.value;
      const markers: string[] = [];
      if (INTERNAL_PATH_PATTERN.test(target) || INTERNAL_FILE_PATTERN.test(target)) {
        markers.push(`internal path segment in ${JSON.stringify(target)}`);
      }
      const leakedSymbols = statement.specifiers.map(exportedName);
      for (const symbol of leakedSymbols) {
        if (INTERNAL_SYMBOL_PATTERN.test(symbol)) {
          markers.push(`internal-marked symbol ${JSON.stringify(symbol)}`);
        }
      }
      reExports.push({
        statement: owner.source.slice(statement.start, statement.end).slice(0, MAX_EXCERPT_CHARS),
        target,
        internalMarkers: markers,
        leakedSymbols: leakedSymbols.slice(0, 20),
      });
    }
  }

  const leaky = reExports.filter(({ internalMarkers }) => internalMarkers.length > 0);
  if (leaky.length === 0) return undefined;

  const leakedNames = new Set(leaky.flatMap(({ leakedSymbols }) => leakedSymbols));
  const reachesThroughBarrel = leakedNames.has("*");
  const externalReach = findModuleImporters(candidate.filePath, projectFiles).filter((importer) =>
    reachesThroughBarrel || importer.importedSymbols.some((symbol) => leakedNames.has(symbol))
  );

  const internalTargets: InternalTargetNote[] = [];
  const seen = new Set<string>();
  for (const { target } of leaky) {
    const resolved = resolveModule(candidate.filePath, target, projectFiles);
    if (!resolved || seen.has(resolved.filePath)) continue;
    seen.add(resolved.filePath);
    internalTargets.push({
      filePath: resolved.filePath,
      documentsInternal: INTERNAL_DOC_PATTERN.test(resolved.source),
      excerpt: resolved.source.slice(0, MAX_EXCERPT_CHARS),
    });
    if (internalTargets.length >= MAX_REEXPORTS) break;
  }

  return {
    abstraction: {
      name,
      exported: isAbstractionExported(parsed.program, declaration, name),
      filePath: candidate.filePath,
      source: candidate.source,
      moduleSource: owner.source.slice(0, 12_000),
    },
    barrel: {
      reExports: leaky,
    },
    externalReach,
    internalTargets,
  };
}
