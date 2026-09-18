import { Visitor } from "oxc-parser";
import { parseCached } from "./parse-cache.js";
import type { AbstractionNode } from "./repository.js";
import type { Candidate, ProjectFile } from "../types.js";
import {
  abstractionName,
  findDirectAbstraction,
  moduleImports,
  resolveModule,
} from "./repository.js";

const MAX_HOMONYMS = 6;
const MAX_EXCERPT_CHARS = 600;

export type HomonymType = {
  filePath: string;
  kind: "interface" | "type-alias";
  members: string[];
  memberOverlapRatio: number;
  excerpt: string;
};

export type ContextHomonymTypeEvidence = {
  abstraction: {
    name: string;
    kind: "interface" | "type-alias";
    filePath: string;
    members: string[];
    excerpt: string;
  };
  homonyms: HomonymType[];
  confusion: {
    eitherImportsOther: boolean;
    sharedClients: string[];
  };
};

type KnownType = {
  name: string;
  filePath: string;
  node: AbstractionNode;
  source: string;
};

function knownTypes(projectFiles: ProjectFile[]): KnownType[] {
  const result: KnownType[] = [];
  for (const file of projectFiles) {
    const parsed = parseCached(file.filePath, file.source);
    if (parsed.errors.some((error) => error.severity === "Error")) continue;
    new Visitor({
      TSInterfaceDeclaration(node) {
        result.push({ name: node.id.name, filePath: file.filePath, node, source: file.source });
      },
      TSTypeAliasDeclaration(node) {
        result.push({ name: node.id.name, filePath: file.filePath, node, source: file.source });
      },
    }).visit(parsed.program);
  }
  return result;
}

function memberNames(node: AbstractionNode): string[] {
  const names = new Set<string>();
  if (node.type === "TSInterfaceDeclaration") {
    for (const member of node.body.body) {
      if (member.type !== "TSPropertySignature" && member.type !== "TSMethodSignature") continue;
      if (member.computed || member.key.type !== "Identifier") continue;
      names.add(member.key.name);
    }
    return [...names];
  }
  if (node.typeAnnotation.type !== "TSTypeLiteral") return [];
  for (const member of node.typeAnnotation.members) {
    if (member.type !== "TSPropertySignature" && member.type !== "TSMethodSignature") continue;
    if (member.computed || member.key.type !== "Identifier") continue;
    names.add(member.key.name);
  }
  return [...names];
}

function overlapRatio(first: string[], second: string[]): number {
  const union = new Set([...first, ...second]);
  if (union.size === 0) return 1;
  const shared = first.filter((name) => second.includes(name)).length;
  return shared / union.size;
}

function importsFile(
  fromFile: ProjectFile,
  targetPath: string,
  projectFiles: ProjectFile[],
): boolean {
  const parsed = parseCached(fromFile.filePath, fromFile.source);
  if (parsed.errors.some((error) => error.severity === "Error")) return false;
  return moduleImports(parsed.program).some((imported) =>
    resolveModule(fromFile.filePath, imported.source, projectFiles)?.filePath === targetPath
  );
}

export function buildContextHomonymTypeEvidence(
  candidate: Candidate,
  projectFiles: ProjectFile[],
): ContextHomonymTypeEvidence | undefined {
  if (candidate.kind !== "abstraction") return undefined;
  const owner = projectFiles.find((file) => file.filePath === candidate.filePath);
  if (!owner) return undefined;
  const parsed = parseCached(owner.filePath, owner.source);
  if (parsed.errors.some((error) => error.severity === "Error")) return undefined;
  const node = findDirectAbstraction(parsed.program, candidate);
  if (!node) return undefined;
  const name = abstractionName(parsed.program, node);
  const members = memberNames(node);

  const homonyms: HomonymType[] = [];
  for (const other of knownTypes(projectFiles)) {
    if (other.name !== name || other.filePath === candidate.filePath) continue;
    if (homonyms.length >= MAX_HOMONYMS) break;
    const otherMembers = memberNames(other.node);
    const ratio = overlapRatio(members, otherMembers);
    // Identical shapes are duplication, not homonymy; that judgment
    // belongs to the duplication rules.
    if (ratio >= 1) continue;
    homonyms.push({
      filePath: other.filePath,
      kind: other.node.type === "TSInterfaceDeclaration" ? "interface" : "type-alias",
      members: otherMembers,
      memberOverlapRatio: Math.round(ratio * 100) / 100,
      excerpt: other.source.slice(other.node.start, other.node.end).slice(0, MAX_EXCERPT_CHARS),
    });
  }
  if (homonyms.length === 0) return undefined;

  const homonymPaths = new Set(homonyms.map(({ filePath }) => filePath));
  const eitherImportsOther = [...homonymPaths].some((path) => {
    const other = projectFiles.find((file) => file.filePath === path);
    return (other && importsFile(other, candidate.filePath, projectFiles))
      || importsFile(owner, path, projectFiles);
  });
  const sharedClients = projectFiles
    .filter((file) =>
      file.filePath !== candidate.filePath
      && !homonymPaths.has(file.filePath)
      && importsFile(file, candidate.filePath, projectFiles)
      && [...homonymPaths].some((path) => importsFile(file, path, projectFiles))
    )
    .map((file) => file.filePath);

  return {
    abstraction: {
      name,
      kind: node.type === "TSInterfaceDeclaration" ? "interface" : "type-alias",
      filePath: candidate.filePath,
      members,
      excerpt: candidate.source.slice(0, MAX_EXCERPT_CHARS),
    },
    homonyms,
    confusion: { eitherImportsOther, sharedClients },
  };
}
