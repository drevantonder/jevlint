import { parseCached } from "./parse-cache.js";
import type { Candidate, ProjectFile } from "../types.js";
import {
  findStateModelDeclaration,
  findStateModelUsages,
  stateModelProperties,
  statePropertyName,
} from "./state-model.js";
import type { StateModelUsage } from "./state-model.js";

export type FanoutBooleanEvidence = {
  name: string;
  optional: boolean;
  readonly: boolean;
  source: string;
};

export type FanoutClusterEvidence = {
  stem: string;
  members: string[];
};

export type MultiSetSiteEvidence = {
  filePath: string;
  source: string;
};

export type BooleanFanoutEvidence = {
  stateType: {
    name: string;
    filePath: string;
    source: string;
    moduleSource: string;
  };
  booleanProperties: FanoutBooleanEvidence[];
  clusters: FanoutClusterEvidence[];
  usages: StateModelUsage[];
  multiSetSites: MultiSetSiteEvidence[];
  coverage: {
    projectFiles: number;
    filesWithTypedUsage: number;
    usagesFound: number;
    usagesIncluded: number;
    truncatedUsages: number;
  };
};

function splitSegments(name: string): string[] {
  return name
    .replace(/([a-z0-9])([A-Z])/g, "$1 $2")
    .split(/[^A-Za-z0-9]+/)
    .map((part) => part.toLowerCase())
    .filter((part) => part.length > 0);
}

function leadingStem(name: string): string {
  const segments = splitSegments(name);
  if (segments.length < 2) return "";
  return segments.slice(0, -1).join("");
}

function commonPrefixLength(left: string, right: string): number {
  const lowerLeft = left.toLowerCase();
  const lowerRight = right.toLowerCase();
  let length = 0;
  while (
    length < lowerLeft.length
    && length < lowerRight.length
    && lowerLeft[length] === lowerRight[length]
  ) length += 1;
  return length;
}

function clusterBooleans(names: string[]): FanoutClusterEvidence[] {
  const parent = new Map(names.map((name) => [name, name]));
  const find = (name: string): string => {
    const root = parent.get(name) ?? name;
    if (root === name) return name;
    const resolved = find(root);
    parent.set(name, resolved);
    return resolved;
  };
  const union = (left: string, right: string): void => {
    parent.set(find(left), find(right));
  };
  for (let index = 0; index < names.length; index += 1) {
    for (let other = index + 1; other < names.length; other += 1) {
      const left = names[index];
      const right = names[other];
      if (!left || !right) continue;
      const leftStem = leadingStem(left);
      const rightStem = leadingStem(right);
      if (leftStem.length >= 2 && leftStem === rightStem) {
        union(left, right);
      } else if (commonPrefixLength(left, right) >= 4) {
        union(left, right);
      }
    }
  }
  const groups = new Map<string, string[]>();
  for (const name of names) {
    const root = find(name);
    groups.set(root, [...(groups.get(root) ?? []), name]);
  }
  return [...groups.values()]
    .filter((members) => members.length >= 3)
    .map((members) => {
      const sorted = [...members].sort();
      const stem = leadingStem(sorted[0] ?? "") || sorted[0]?.slice(0, 4).toLowerCase() || "";
      return { stem, members: sorted };
    })
    .sort((left, right) => right.members.length - left.members.length);
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

const BOOLEAN_PREFIXES = /^(is|has|was|should|can|show|use|allow|enable|disable)/i;

function unionFragments(members: string[]): string[] {
  const fragments = new Set<string>();
  for (const member of members) {
    const stripped = member.replace(BOOLEAN_PREFIXES, "").toLowerCase();
    if (stripped.length >= 3) fragments.add(stripped);
    const segments = splitSegments(member);
    const last = segments[segments.length - 1];
    if (last && last.length >= 3) fragments.add(last);
    const first = segments[0];
    if (first && first.length >= 4) fragments.add(first);
  }
  return [...fragments];
}

function hasNearbyTaggedUnion(moduleSource: string, members: string[]): boolean {
  const fragments = unionFragments(members);
  if (fragments.length < 2) return false;
  const unionPattern = /type\s+\w+\s*=\s*("[^"]*"|'[^']*'|\w+)(\s*\|\s*("[^"]*"|'[^']*'|\w+))+/g;
  let match = unionPattern.exec(moduleSource);
  while (match) {
    const unionSource = match[0].toLowerCase();
    const hits = fragments.filter((fragment) => unionSource.includes(escapeRegExp(fragment))).length;
    if (hits >= 2) return true;
    match = unionPattern.exec(moduleSource);
  }
  return false;
}

function collectMultiSetSites(
  members: string[],
  projectFiles: ProjectFile[],
): MultiSetSiteEvidence[] {
  const patterns = members.map((member) => new RegExp(`\\b${escapeRegExp(member)}\\b`));
  const sites: MultiSetSiteEvidence[] = [];
  for (const file of projectFiles) {
    const lines = file.source.split("\n");
    for (const line of lines) {
      if (sites.length >= 8) return sites;
      const hits = patterns.filter((pattern) => pattern.test(line)).length;
      if (hits >= 2) sites.push({ filePath: file.filePath, source: line.trim().slice(0, 400) });
    }
  }
  return sites;
}

export function buildBooleanFanoutEvidence(
  candidate: Candidate,
  projectFiles: ProjectFile[],
): BooleanFanoutEvidence | undefined {
  if (candidate.kind !== "abstraction") return undefined;
  const owner = projectFiles.find((file) => file.filePath === candidate.filePath);
  if (!owner) return undefined;
  const parsed = parseCached(owner.filePath, owner.source);
  if (parsed.errors.some((error) => error.severity === "Error")) return undefined;
  const declaration = findStateModelDeclaration(parsed.program, candidate);
  if (!declaration) return undefined;

  const booleanProperties = stateModelProperties(declaration).flatMap((property) => {
    const name = statePropertyName(property);
    if (!name || property.typeAnnotation?.typeAnnotation.type !== "TSBooleanKeyword") return [];
    return [{
      name,
      optional: property.optional,
      readonly: property.readonly,
      source: owner.source.slice(property.start, property.end),
    }];
  });
  if (booleanProperties.length < 3) return undefined;

  const clusters = clusterBooleans(booleanProperties.map((property) => property.name));
  if (clusters.length === 0) return undefined;
  const clusteredMembers = clusters.flatMap((cluster) => cluster.members);
  if (hasNearbyTaggedUnion(owner.source, clusteredMembers)) return undefined;

  const name = declaration.id.name;
  const usageResult = findStateModelUsages(
    owner.filePath,
    name,
    booleanProperties.map((property) => property.name),
    projectFiles,
  );
  return {
    stateType: {
      name,
      filePath: owner.filePath,
      source: candidate.source,
      moduleSource: owner.source.slice(0, 16_000),
    },
    booleanProperties,
    clusters,
    usages: usageResult.usages,
    multiSetSites: collectMultiSetSites(clusteredMembers, projectFiles),
    coverage: {
      projectFiles: projectFiles.length,
      filesWithTypedUsage: usageResult.files,
      usagesFound: usageResult.total,
      usagesIncluded: usageResult.usages.length,
      truncatedUsages: usageResult.usages.filter(({ truncated }) => truncated).length,
    },
  };
}
