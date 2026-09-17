import { posix } from "node:path";
import type { Candidate, ProjectFile, SourceFile } from "../types.js";
import {
  buildModuleEvidence,
  buildModuleGraph,
  isBarrelFile,
  isFrameworkScaffolded,
  parseProgram,
} from "./module.js";
import type { ModuleEvidence } from "./module.js";
import { moduleImports, resolveModule } from "./repository.js";

export type TeamBoundaryCrossing = {
  specifier: string;
  resolved: string;
  ownerTeam: string;
  targetTeam: string;
  viaEntry: boolean;
  targetEntry: string | null;
};

export type TeamBoundaryCrossingEvidence = {
  module: ModuleEvidence;
  ownersFile: string;
  crossings: TeamBoundaryCrossing[];
  precedent: { ownerTeam: string; targetTeam: string; existingEdges: number }[];
};

function isOwnersFile(filePath: string): boolean {
  return posix.basename(filePath) === "CODEOWNERS";
}

function globToRegExp(glob: string): RegExp {
  let out = "";
  for (let index = 0; index < glob.length; index += 1) {
    const char = glob[index] ?? "";
    if (char === "*") {
      if (glob[index + 1] === "*") {
        out += ".*";
        index += 1;
        if (glob[index + 1] === "/") index += 1;
      } else {
        out += "[^/]*";
      }
      continue;
    }
    if (char === "?") {
      out += "[^/]";
      continue;
    }
    out += char.replace(/[.+^${}()|[\]\\]/, "\\$&");
  }
  return new RegExp(`^${out}$`);
}

function patternMatches(pattern: string, filePath: string): boolean {
  const normalized = filePath.replaceAll("\\", "/");
  if (pattern.endsWith("/")) {
    const dir = pattern.replace(/^\/+/, "").replace(/\/+$/, "");
    return normalized === dir || normalized.startsWith(`${dir}/`);
  }
  const stripped = pattern.replace(/^\/+/, "");
  if (!stripped.includes("/")) {
    return globToRegExp(stripped).test(posix.basename(normalized));
  }
  return globToRegExp(stripped).test(normalized.replace(/^\//, ""));
}

function normalizeOwner(token: string): string {
  return token.replace(/^@/, "");
}

export function parseOwnersFile(source: string): { pattern: string; owners: string[] }[] {
  const entries: { pattern: string; owners: string[] }[] = [];
  for (const line of source.split("\n")) {
    const trimmed = line.trim();
    if (trimmed === "" || trimmed.startsWith("#")) continue;
    const parts = trimmed.split(/\s+/);
    const pattern = parts[0];
    const owners = (parts.slice(1)).map(normalizeOwner).filter((owner) => owner !== "");
    if (!pattern || owners.length === 0) continue;
    entries.push({ pattern, owners });
  }
  return entries;
}

export function ownerOf(filePath: string, entries: { pattern: string; owners: string[] }[]): string[] {
  let owners: string[] = [];
  for (const entry of entries) {
    if (patternMatches(entry.pattern, filePath)) owners = entry.owners;
  }
  return owners;
}

function previousSpecifiers(filePath: string, oldSource: string | null): Set<string> | undefined {
  if (oldSource === null) return new Set();
  const program = parseProgram(filePath, oldSource);
  if (!program) return undefined;
  return new Set(moduleImports(program).map((item) => item.source));
}

function barrelInDir(dir: string, projectFiles: ProjectFile[]): string | null {
  const barrel = projectFiles.find((file) =>
    file.filePath !== "" && posix.dirname(file.filePath) === dir && isBarrelFile(file.filePath)
  );
  return barrel?.filePath ?? null;
}

export function buildTeamBoundaryCrossingEvidence(
  candidate: Candidate,
  projectFiles: ProjectFile[],
  changes: SourceFile[] = [],
): TeamBoundaryCrossingEvidence | undefined {
  if (candidate.kind !== "module") return undefined;
  if (isFrameworkScaffolded(candidate.filePath)) return undefined;
  const ownersFile = projectFiles.find((file) => isOwnersFile(file.filePath));
  if (!ownersFile) return undefined;
  const entries = parseOwnersFile(ownersFile.source);
  if (entries.length === 0) return undefined;

  const module = buildModuleEvidence(candidate.filePath, changes, projectFiles);
  if (!module) return undefined;

  const change = changes.find((item) => item.filePath === candidate.filePath);
  const previous = previousSpecifiers(candidate.filePath, change?.oldSource ?? null);
  if (!previous) return undefined;

  const ownerTeams = ownerOf(candidate.filePath, entries);
  if (ownerTeams.length === 0) return undefined;

  const crossings: TeamBoundaryCrossing[] = [];
  for (const edge of module.importEdgesOut) {
    if (edge.resolved === null) continue;
    if (previous.has(edge.to)) continue;
    if (edge.resolved === candidate.filePath) continue;
    const targetTeams = ownerOf(edge.resolved, entries);
    if (targetTeams.length === 0) continue;
    const shared = targetTeams.some((team) => ownerTeams.includes(team));
    if (shared) continue;
    const targetDir = posix.dirname(edge.resolved);
    const targetEntry = barrelInDir(targetDir, projectFiles);
    crossings.push({
      specifier: edge.to,
      resolved: edge.resolved,
      ownerTeam: ownerTeams.join(","),
      targetTeam: targetTeams.join(","),
      viaEntry: targetEntry !== null && edge.resolved === targetEntry,
      targetEntry,
    });
  }
  if (crossings.length === 0) return undefined;

  const graph = buildModuleGraph(projectFiles);
  const precedent = new Map<string, number>();
  for (const [from, specifiers] of graph.specifiers) {
    if (from === candidate.filePath) continue;
    const fromOwners = ownerOf(from, entries);
    if (fromOwners.length === 0) continue;
    for (const specifier of specifiers) {
      if (from === candidate.filePath && previous.has(specifier)) continue;
      const resolved = resolveModule(from, specifier, projectFiles);
      if (!resolved) continue;
      const toOwners = ownerOf(resolved.filePath, entries);
      if (toOwners.length === 0) continue;
      const key = `${fromOwners.join(",")}\u0000${toOwners.join(",")}`;
      precedent.set(key, (precedent.get(key) ?? 0) + 1);
    }
  }

  return {
    module,
    ownersFile: ownersFile.filePath,
    crossings,
    precedent: crossings.map(({ ownerTeam, targetTeam }) => ({
      ownerTeam,
      targetTeam,
      existingEdges: precedent.get(`${ownerTeam}\u0000${targetTeam}`) ?? 0,
    })),
  };
}
