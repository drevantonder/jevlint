import { posix } from "node:path";
import { z } from "zod";
import type { Candidate, ProjectFile, SourceFile } from "../types.js";
import {
  buildModuleEvidence,
  isBarrelFile,
  isFrameworkScaffolded,
  parseProgram,
} from "./module.js";
import type { ModuleEvidence } from "./module.js";
import { moduleImports } from "./repository.js";

export type ServiceEdgeCoupling = "relative" | "workspace-package";

export type CrossServiceSourceReach = {
  specifier: string;
  resolved: string;
  ownerUnit: string;
  targetUnit: string;
  coupling: ServiceEdgeCoupling;
  viaEntry: boolean;
  targetEntry: string | null;
};

export type CrossServiceSourceReachEvidence = {
  module: ModuleEvidence;
  manifests: string[];
  crossings: CrossServiceSourceReach[];
};

const MANIFEST_BASENAME = "package.json";

const manifestNameSchema = z.object({ name: z.string().optional() });

function manifestName(source: string): string | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(source);
  } catch {
    return null;
  }
  const result = manifestNameSchema.safeParse(parsed);
  if (!result.success || result.data.name === undefined || result.data.name === "") return null;
  return result.data.name;
}

function isManifest(source: string): boolean {
  let parsed: unknown;
  try {
    parsed = JSON.parse(source);
  } catch {
    return false;
  }
  return manifestNameSchema.safeParse(parsed).success;
}

function manifestDir(manifestPath: string): string {
  return posix.dirname(manifestPath) === "." ? "" : posix.dirname(manifestPath);
}

function nearestManifest(filePath: string, manifests: ProjectFile[]): ProjectFile | undefined {
  let best: ProjectFile | undefined;
  let bestDepth = -1;
  for (const manifest of manifests) {
    const dir = manifestDir(manifest.filePath);
    if (dir === "" || filePath === dir || filePath.startsWith(`${dir}/`)) {
      const depth = dir === "" ? 0 : dir.split("/").length;
      if (depth > bestDepth) {
        best = manifest;
        bestDepth = depth;
      }
    }
  }
  return best;
}

function unitLabel(manifest: ProjectFile): string {
  return manifestName(manifest.source) ?? manifest.filePath;
}

function previousSpecifiers(filePath: string, oldSource: string | null): Set<string> | undefined {
  if (oldSource === null) return new Set();
  const program = parseProgram(filePath, oldSource);
  if (!program) return undefined;
  return new Set(moduleImports(program).map((item) => item.source));
}

function barrelInDir(dir: string, projectFiles: ProjectFile[]): string | null {
  const barrel = projectFiles.find((file) =>
    posix.dirname(file.filePath) === dir && isBarrelFile(file.filePath)
  );
  return barrel?.filePath ?? null;
}

const PROBE_EXTENSIONS = [".ts", ".tsx", ".mts", ".cts", ".js", ".jsx", ".mjs", ".cjs"];

function resolveSubpath(dir: string, subpath: string, projectFiles: ProjectFile[]): string | null {
  const base = subpath === "" ? dir : posix.normalize(posix.join(dir, subpath));
  const paths = new Set(projectFiles.map((file) => posix.normalize(file.filePath)));
  if (paths.has(base)) return base;
  for (const extension of PROBE_EXTENSIONS) {
    if (paths.has(`${base}${extension}`)) return `${base}${extension}`;
  }
  for (const extension of PROBE_EXTENSIONS) {
    if (paths.has(`${base}/index${extension}`)) return `${base}/index${extension}`;
  }
  return null;
}

function bareSpecifierTarget(
  specifier: string,
  manifests: ProjectFile[],
  projectFiles: ProjectFile[],
): { manifest: ProjectFile; resolved: string } | undefined {
  for (const manifest of manifests) {
    const name = manifestName(manifest.source);
    if (name === null) continue;
    if (specifier !== name && !specifier.startsWith(`${name}/`)) continue;
    const subpath = specifier === name ? "" : specifier.slice(name.length + 1);
    const dir = manifestDir(manifest.filePath);
    const resolved = subpath === ""
      ? (barrelInDir(dir, projectFiles) ?? resolveSubpath(dir, "src/index", projectFiles))
      : resolveSubpath(dir, subpath, projectFiles) ?? resolveSubpath(dir, `src/${subpath}`, projectFiles);
    if (resolved === null) continue;
    return { manifest, resolved };
  }
  return undefined;
}

export function buildCrossServiceSourceReachEvidence(
  candidate: Candidate,
  projectFiles: ProjectFile[],
  changes: SourceFile[] = [],
): CrossServiceSourceReachEvidence | undefined {
  if (candidate.kind !== "module") return undefined;
  if (isFrameworkScaffolded(candidate.filePath)) return undefined;
  const manifests = projectFiles.filter((file) =>
    posix.basename(file.filePath) === MANIFEST_BASENAME && isManifest(file.source)
  );
  if (manifests.length < 2) return undefined;

  const module = buildModuleEvidence(candidate.filePath, changes, projectFiles);
  if (!module) return undefined;

  const change = changes.find((item) => item.filePath === candidate.filePath);
  const previous = previousSpecifiers(candidate.filePath, change?.oldSource ?? null);
  if (!previous) return undefined;

  const ownerManifest = nearestManifest(candidate.filePath, manifests);
  if (!ownerManifest) return undefined;

  const owner = projectFiles.find((file) => file.filePath === candidate.filePath);
  if (!owner) return undefined;
  const ownerProgram = parseProgram(owner.filePath, owner.source);
  if (!ownerProgram) return undefined;

  const crossings: CrossServiceSourceReach[] = [];
  const seen = new Set<string>();
  const push = (crossing: CrossServiceSourceReach): void => {
    const key = `${crossing.specifier}\u0000${crossing.resolved}`;
    if (seen.has(key)) return;
    seen.add(key);
    crossings.push(crossing);
  };
  for (const edge of module.importEdgesOut) {
    if (edge.resolved === null) continue;
    if (previous.has(edge.to)) continue;
    if (edge.resolved === candidate.filePath) continue;
    const targetManifest = nearestManifest(edge.resolved, manifests);
    if (!targetManifest || targetManifest.filePath === ownerManifest.filePath) continue;
    const targetEntry = barrelInDir(posix.dirname(edge.resolved), projectFiles);
    push({
      specifier: edge.to,
      resolved: edge.resolved,
      ownerUnit: unitLabel(ownerManifest),
      targetUnit: unitLabel(targetManifest),
      coupling: "relative",
      viaEntry: targetEntry !== null && edge.resolved === targetEntry,
      targetEntry,
    });
  }
  for (const imported of moduleImports(ownerProgram)) {
    if (imported.source.startsWith(".")) continue;
    if (previous.has(imported.source)) continue;
    const target = bareSpecifierTarget(imported.source, manifests, projectFiles);
    if (!target || target.manifest.filePath === ownerManifest.filePath) continue;
    const targetEntry = barrelInDir(posix.dirname(target.resolved), projectFiles);
    push({
      specifier: imported.source,
      resolved: target.resolved,
      ownerUnit: unitLabel(ownerManifest),
      targetUnit: unitLabel(target.manifest),
      coupling: "workspace-package",
      viaEntry: targetEntry !== null && target.resolved === targetEntry,
      targetEntry,
    });
  }
  if (crossings.length === 0) return undefined;

  return {
    module,
    manifests: manifests.map((file) => file.filePath).sort(),
    crossings,
  };
}
