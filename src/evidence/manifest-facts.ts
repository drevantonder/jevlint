import { z } from "zod";
import type { ProjectFile } from "../types.js";

export type ManifestFacts = {
  hasManifest: boolean;
  dependencyNames: string[];
  lockfilePresent: boolean;
  matchedDep: string | null;
  siblingImporters: string[];
  candidateImportsDep: boolean;
};

const LOCKFILE_NAMES = new Set([
  "package-lock.json",
  "pnpm-lock.yaml",
  "yarn.lock",
  "bun.lock",
  "bun.lockb",
]);

function baseName(filePath: string): string {
  return filePath.replaceAll("\\", "/").split("/").pop() ?? filePath;
}

const dependencySection = z.record(z.string(), z.string());
const manifestSchema = z.object({
  dependencies: dependencySection.optional(),
  devDependencies: dependencySection.optional(),
  peerDependencies: dependencySection.optional(),
  optionalDependencies: dependencySection.optional(),
});

type Manifest = z.infer<typeof manifestSchema>;

function parseManifest(source: string): Manifest | undefined {
  let parsed: unknown;
  try {
    parsed = JSON.parse(source);
  } catch {
    return undefined;
  }
  const result = manifestSchema.safeParse(parsed);
  return result.success ? result.data : undefined;
}

function dependencyNamesOf(manifest: Manifest): string[] {
  const names = new Set<string>();
  const sections = [
    manifest.dependencies,
    manifest.devDependencies,
    manifest.peerDependencies,
    manifest.optionalDependencies,
  ];
  for (const section of sections) {
    if (!section) continue;
    for (const name of Object.keys(section)) names.add(name);
  }
  return [...names].sort();
}

const IMPORT_PATTERNS = [
  /\bimport\s+(?:[^'"]*?\sfrom\s+)?['"]([^'"]+)['"]/g,
  /\brequire\s*\(\s*['"]([^'"]+)['"]\s*\)/g,
  /\bimport\s*\(\s*['"]([^'"]+)['"]\s*\)/g,
];

function importedSources(source: string): string[] {
  const found: string[] = [];
  for (const pattern of IMPORT_PATTERNS) {
    pattern.lastIndex = 0;
    let match = pattern.exec(source);
    while (match) {
      const specifier = match[1];
      if (specifier) found.push(specifier);
      match = pattern.exec(source);
    }
  }
  return found;
}

function specifierImportsDep(specifier: string, dep: string): boolean {
  return specifier === dep || specifier.startsWith(`${dep}/`);
}

export function manifestFacts(
  projectFiles: ProjectFile[],
  candidateFilePath: string,
  depNames: string[],
): ManifestFacts {
  const empty: ManifestFacts = {
    hasManifest: false,
    dependencyNames: [],
    lockfilePresent: false,
    matchedDep: null,
    siblingImporters: [],
    candidateImportsDep: false,
  };
  const manifestFile = projectFiles.find((file) => baseName(file.filePath) === "package.json");
  if (!manifestFile) return empty;
  const manifest = parseManifest(manifestFile.source);
  if (!manifest) return empty;
  const dependencyNames = dependencyNamesOf(manifest);
  const installed = new Set(dependencyNames);
  const matchedDep = depNames.find((dep) => installed.has(dep)) ?? null;
  const lockfilePresent = projectFiles.some((file) => LOCKFILE_NAMES.has(baseName(file.filePath)));
  if (!matchedDep) {
    return {
      hasManifest: true,
      dependencyNames,
      lockfilePresent,
      matchedDep,
      siblingImporters: [],
      candidateImportsDep: false,
    };
  }
  const siblingImporters: string[] = [];
  let candidateImportsDep = false;
  for (const file of projectFiles) {
    if (baseName(file.filePath) === "package.json") continue;
    if (!/\.[cm]?[jt]sx?$/.test(file.filePath)) continue;
    const uses = importedSources(file.source).some((specifier) =>
      specifierImportsDep(specifier, matchedDep)
    );
    if (!uses) continue;
    if (file.filePath === candidateFilePath) candidateImportsDep = true;
    else siblingImporters.push(file.filePath);
  }
  siblingImporters.sort();
  return {
    hasManifest: true,
    dependencyNames,
    lockfilePresent,
    matchedDep,
    siblingImporters: siblingImporters.slice(0, 10),
    candidateImportsDep,
  };
}
