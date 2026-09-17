import type { Candidate, ProjectFile, SourceFile } from "../types.js";
import { manifestDependencies } from "./repository.js";

export type ShelfDuplication = {
  imported: string;
  capability: string;
  incumbents: string[];
  siblingIncumbentFiles: string[];
};

export type SecondShelfDependencyEvidence = {
  anchorFile: string;
  manifest: {
    filePath: string | null;
    dependencyNames: string[];
  };
  duplications: ShelfDuplication[];
};

type CapabilityShelf = {
  capability: string;
  packages: string[];
};

const CAPABILITY_SHELVES: CapabilityShelf[] = [
  { capability: "date", packages: ["dayjs", "date-fns", "moment", "luxon", "@date-fns/tz", "date-fns-tz", "dayjs-plugin-utc"] },
  { capability: "http", packages: ["axios", "got", "node-fetch", "undici", "ky", "superagent", "node-fetch-native"] },
  { capability: "schema", packages: ["zod", "yup", "ajv", "joi", "valibot", "superstruct"] },
  { capability: "logging", packages: ["winston", "pino", "bunyan", "loglevel"] },
  { capability: "id", packages: ["uuid", "nanoid", "ulid"] },
];

function capabilityOf(packageName: string): string | null {
  for (const shelf of CAPABILITY_SHELVES) {
    if (shelf.packages.includes(packageName)) return shelf.capability;
  }
  return null;
}

function bareImports(source: string): string[] {
  const result = new Set<string>();
  for (const match of source.matchAll(/(?:from\s+|require\(\s*)["']([^"']+)["']/g)) {
    const specifier = match[1];
    if (specifier && !specifier.startsWith(".") && !specifier.startsWith("/") && !specifier.startsWith("node:")) {
      result.add(specifier);
    }
  }
  return [...result];
}

function manifestLookup(anchorPath: string, projectFiles: ProjectFile[]) {
  const manifests = projectFiles.filter((file) => /(^|\/)package\.json$/.test(file.filePath));
  const owned = manifests
    .filter((file) => {
      const dir = file.filePath.slice(0, file.filePath.length - "package.json".length);
      return anchorPath.startsWith(dir);
    })
    .sort((left, right) => right.filePath.length - left.filePath.length);
  const manifest = owned[0] ?? manifests[0];
  const names = manifest ? manifestDependencies(manifest.source).map((entry) => entry.name) : [];
  return { manifest, names };
}

export function buildSecondShelfDependencyEvidence(
  candidate: Candidate,
  projectFiles: ProjectFile[],
  _changes: SourceFile[] = [],
): SecondShelfDependencyEvidence | undefined {
  if (candidate.kind !== "change") return undefined;
  const anchor = projectFiles.find((file) => file.filePath === candidate.filePath);
  if (!anchor) return undefined;

  const mapped = bareImports(anchor.source)
    .map((specifier) => ({ specifier, capability: capabilityOf(specifier) }))
    .filter((entry): entry is { specifier: string; capability: string } => entry.capability !== null);
  if (mapped.length === 0) return undefined;

  const { manifest, names } = manifestLookup(candidate.filePath, projectFiles);

  const duplications: ShelfDuplication[] = [];
  for (const { specifier, capability } of mapped) {
    const incumbents = names.filter((name) =>
      name !== specifier && capabilityOf(name) === capability
    );
    if (incumbents.length === 0) continue;
    const siblingIncumbentFiles = projectFiles
      .filter((file) =>
        file.filePath !== candidate.filePath
        && bareImports(file.source).some((other) => incumbents.includes(other))
      )
      .map((file) => file.filePath)
      .slice(0, 10);
    duplications.push({ imported: specifier, capability, incumbents, siblingIncumbentFiles });
  }

  return {
    anchorFile: candidate.filePath,
    manifest: {
      filePath: manifest?.filePath ?? null,
      dependencyNames: names.slice(0, 60),
    },
    duplications: duplications.slice(0, 10),
  };
}
