import { Visitor } from "oxc-parser";
import { parseCached } from "./parse-cache.js";
import type { Candidate, ProjectFile } from "../types.js";
import {
  abstractionName,
  findDirectAbstraction,
  findModuleImporters,
  isAbstractionExported,
} from "./repository.js";
import type { AbstractionNode } from "./repository.js";

export type TwinType = {
  name: string;
  filePath: string;
  properties: string[];
  sourceExcerpt: string;
};

export type TwinConsumers = {
  sharedImporterFiles: string[];
  candidateOnlyImporters: string[];
  twinOnlyImporters: string[];
};

export type ConvergentTwinTypesEvidence = {
  abstraction: {
    name: string;
    exported: boolean;
    filePath: string;
    source: string;
    properties: string[];
  };
  twin: TwinType;
  sharedProperties: string[];
  propertyJaccard: number;
  consumers: TwinConsumers;
};

function keyName(source: string, start: number, end: number): string | undefined {
  const raw = source.slice(start, end).trim();
  const first = raw[0];
  const last = raw.at(-1);
  const name = raw.length >= 2 && (first === "\"" || first === "'") && last === first
    ? raw.slice(1, -1)
    : raw;
  if (/^[A-Za-z_$][\w$]*$/.test(name)) return name;
  return undefined;
}

function propertiesOf(source: string, node: AbstractionNode): string[] {
  const names = new Set<string>();
  if (node.type === "TSInterfaceDeclaration") {
    for (const member of node.body.body) {
      if (member.type !== "TSPropertySignature" || member.computed) continue;
      const name = keyName(source, member.key.start, member.key.end);
      if (name !== undefined) names.add(name);
    }
    return [...names].sort();
  }
  const annotation = node.typeAnnotation;
  if (annotation.type !== "TSTypeLiteral") return [];
  for (const member of annotation.members) {
    if (member.type !== "TSPropertySignature" || member.computed) continue;
    const name = keyName(source, member.key.start, member.key.end);
    if (name !== undefined) names.add(name);
  }
  return [...names].sort();
}

function abstractionsIn(file: ProjectFile): { node: AbstractionNode; name: string }[] {
  const parsed = parseCached(file.filePath, file.source);
  if (parsed.errors.some((error) => error.severity === "Error")) return [];
  const result: { node: AbstractionNode; name: string }[] = [];
  new Visitor({
    TSInterfaceDeclaration(node) {
      result.push({ node, name: node.id.name });
    },
    TSTypeAliasDeclaration(node) {
      result.push({ node, name: node.id.name });
    },
  }).visit(parsed.program);
  return result;
}

export function buildConvergentTwinTypesEvidence(
  candidate: Candidate,
  projectFiles: ProjectFile[],
): ConvergentTwinTypesEvidence | undefined {
  if (candidate.kind !== "abstraction") return undefined;
  const owner = projectFiles.find((file) => file.filePath === candidate.filePath);
  if (!owner) return undefined;
  const parsed = parseCached(owner.filePath, owner.source);
  if (parsed.errors.some((error) => error.severity === "Error")) return undefined;
  const node = findDirectAbstraction(parsed.program, candidate);
  if (!node) return undefined;
  const name = abstractionName(parsed.program, node);
  const properties = propertiesOf(owner.source, node);
  if (properties.length < 3) return undefined;
  const own = new Set(properties);

  let best: TwinType | undefined;
  let bestShared: string[] = [];
  let bestScore = 0;
  for (const file of projectFiles) {
    if (file.filePath === owner.filePath) continue;
    for (const other of abstractionsIn(file)) {
      if (other.node.start === node.start && file.filePath === owner.filePath) continue;
      const otherProperties = propertiesOf(file.source, other.node);
      if (otherProperties.length < 3) continue;
      const shared = otherProperties.filter((property) => own.has(property));
      if (shared.length < 3) continue;
      const score = shared.length / new Set([...properties, ...otherProperties]).size;
      if (score > bestScore) {
        bestScore = score;
        bestShared = [...shared].sort();
        best = {
          name: other.name,
          filePath: file.filePath,
          properties: otherProperties,
          sourceExcerpt: file.source.slice(other.node.start, other.node.end).slice(0, 2_000),
        };
      }
    }
  }
  if (!best || bestScore < 0.5) return undefined;

  const candidateImporters = new Set(
    findModuleImporters(owner.filePath, projectFiles).map(({ filePath }) => filePath),
  );
  const twinImporters = new Set(
    findModuleImporters(best.filePath, projectFiles).map(({ filePath }) => filePath),
  );

  return {
    abstraction: {
      name,
      exported: isAbstractionExported(parsed.program, node, name),
      filePath: owner.filePath,
      source: candidate.source,
      properties,
    },
    twin: best,
    sharedProperties: bestShared,
    propertyJaccard: Math.round(bestScore * 1000) / 1000,
    consumers: {
      sharedImporterFiles: [...candidateImporters].filter((path) => twinImporters.has(path)).sort().slice(0, 10),
      candidateOnlyImporters: [...candidateImporters].filter((path) => !twinImporters.has(path)).sort().slice(0, 10),
      twinOnlyImporters: [...twinImporters].filter((path) => !candidateImporters.has(path)).sort().slice(0, 10),
    },
  };
}
