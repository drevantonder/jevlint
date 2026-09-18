import { Visitor } from "oxc-parser";
import { parseCached } from "./parse-cache.js";
import type {
  TSEnumDeclaration,
  TSInterfaceDeclaration,
  TSTypeAliasDeclaration,
} from "oxc-parser";
import type { Candidate, ProjectFile } from "../types.js";
import { findDirectAbstraction } from "./repository.js";

export type LiteralSetSite = {
  name: string;
  filePath: string;
  source: string;
  literals: string[];
};

export type MappingFunctionEvidence = {
  filePath: string;
  name: string;
  source: string;
};

export type ParallelEnumerationsEvidence = {
  owner: LiteralSetSite;
  sibling: LiteralSetSite;
  shared: string[];
  onlyInOwner: string[];
  onlyInSibling: string[];
  mappingFunction: MappingFunctionEvidence | null;
};

type NamedDeclaration = TSTypeAliasDeclaration | TSInterfaceDeclaration | TSEnumDeclaration;

function normalizeLiteral(value: string): string {
  const trimmed = value.trim();
  if (
    (trimmed.startsWith("\"") && trimmed.endsWith("\""))
    || (trimmed.startsWith("'") && trimmed.endsWith("'"))
  ) return trimmed.slice(1, -1).toLowerCase();
  return trimmed.toLowerCase();
}

function memberKeyName(key: { start: number; end: number }, source: string): string | undefined {
  const raw = source.slice(key.start, key.end).trim();
  const unquoted = raw.length >= 2 && (raw.startsWith("\"") || raw.startsWith("'"))
    ? raw.slice(1, -1)
    : raw;
  return /^[A-Za-z_$][\w$]*$/.test(unquoted) ? unquoted : undefined;
}

function literalsOf(declaration: NamedDeclaration, source: string): string[] | undefined {
  if (declaration.type === "TSTypeAliasDeclaration") {
    const annotation = declaration.typeAnnotation;
    if (annotation.type === "TSUnionType") {
      if (annotation.types.length === 0) return undefined;
      if (annotation.types.some((item) => item.type !== "TSLiteralType")) return undefined;
      return annotation.types.map((item) => normalizeLiteral(source.slice(item.start, item.end)));
    }
    if (annotation.type === "TSTypeLiteral") {
      const names = annotation.members.flatMap((member) => {
        if (member.type !== "TSPropertySignature" || member.computed) return [];
        const name = memberKeyName(member.key, source);
        return name === undefined ? [] : [name.toLowerCase()];
      });
      return names.length === 0 ? undefined : names;
    }
    return undefined;
  }
  if (declaration.type === "TSInterfaceDeclaration") {
    const names = declaration.body.body.flatMap((member) => {
      if (
        (member.type !== "TSPropertySignature" && member.type !== "TSMethodSignature")
        || member.computed
      ) return [];
      const name = memberKeyName(member.key, source);
      return name === undefined ? [] : [name.toLowerCase()];
    });
    return names.length === 0 ? undefined : names;
  }
  const names = declaration.body.members.flatMap((member) => {
    if (member.type !== "TSEnumMember") return [];
    const name = memberKeyName(member.id, source);
    return name === undefined ? [] : [name.toLowerCase()];
  });
  return names.length === 0 ? undefined : names;
}

const STEM_SUFFIXES = ["label", "labels", "map", "table", "names", "keys", "values", "schema", "lookup"];

function stripSuffixes(name: string): string {
  const lower = name.toLowerCase();
  for (const suffix of STEM_SUFFIXES) {
    if (lower.length > suffix.length + 2 && lower.endsWith(suffix)) {
      return lower.slice(0, -suffix.length);
    }
  }
  return lower;
}

function namesCorrespond(left: string, right: string): boolean {
  const a = left.toLowerCase();
  const b = right.toLowerCase();
  if (a === b) return false;
  if (a.length < 3 || b.length < 3) return false;
  if (a.includes(b) || b.includes(a)) return true;
  return stripSuffixes(a) === stripSuffixes(b);
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function isDerived(ownerName: string, siblingName: string, ownerSource: string, siblingSource: string): boolean {
  if (/^\s*\/\/\s*@generated/m.test(ownerSource) || /^\s*\/\/\s*@generated/m.test(siblingSource)) {
    return true;
  }
  const patterns = [ownerName, siblingName].map((name) => new RegExp(
    `\\bkeyof\\s+${escapeRegExp(name)}\\b|\\btypeof\\s+${escapeRegExp(name)}\\b|\\bRecord<\\s*${escapeRegExp(name)}\\b|\\b${escapeRegExp(name)}\\s*\\[`,
  ));
  const [ownerPattern, siblingPattern] = patterns;
  if (!ownerPattern || !siblingPattern) return false;
  return ownerPattern.test(siblingSource) || siblingPattern.test(ownerSource);
}

function collectSiblingSets(
  ownerPath: string,
  ownerName: string,
  ownerLiterals: string[],
  projectFiles: ProjectFile[],
): LiteralSetSite[] {
  const result: LiteralSetSite[] = [];
  const ownerSet = new Set(ownerLiterals);
  for (const file of projectFiles) {
    const parsed = parseCached(file.filePath, file.source);
    if (parsed.errors.some((error) => error.severity === "Error")) continue;
    const visit = (node: NamedDeclaration): void => {
      if (file.filePath === ownerPath && node.id.name === ownerName) return;
      const literals = literalsOf(node, file.source);
      if (!literals || literals.length < 2) return;
      if (!namesCorrespond(ownerName, node.id.name)) return;
      const shared = literals.filter((literal) => ownerSet.has(literal));
      if (shared.length === 0) return;
      result.push({
        name: node.id.name,
        filePath: file.filePath,
        source: file.source.slice(node.start, node.end),
        literals,
      });
    };
    new Visitor({
      TSEnumDeclaration: visit,
      TSInterfaceDeclaration: visit,
      TSTypeAliasDeclaration: visit,
    }).visit(parsed.program);
  }
  return result;
}

function findMappingFunction(
  ownerName: string,
  siblingName: string,
  projectFiles: ProjectFile[],
): MappingFunctionEvidence | null {
  const ownerPattern = new RegExp(`\\b${escapeRegExp(ownerName)}\\b`);
  const siblingPattern = new RegExp(`\\b${escapeRegExp(siblingName)}\\b`);
  for (const file of projectFiles) {
    const parsed = parseCached(file.filePath, file.source);
    if (parsed.errors.some((error) => error.severity === "Error")) continue;
    let found: MappingFunctionEvidence | null = null;
    new Visitor({
      FunctionDeclaration(node) {
        const source = file.source.slice(node.start, node.end);
        if (ownerPattern.test(source) && siblingPattern.test(source)) {
          found = {
            filePath: file.filePath,
            name: node.id?.name ?? "(anonymous)",
            source: source.slice(0, 4_000),
          };
        }
      },
    }).visit(parsed.program);
    if (found) return found;
  }
  return null;
}

export function buildParallelEnumerationsEvidence(
  candidate: Candidate,
  projectFiles: ProjectFile[],
): ParallelEnumerationsEvidence | undefined {
  if (candidate.kind !== "abstraction") return undefined;
  const owner = projectFiles.find((file) => file.filePath === candidate.filePath);
  if (!owner) return undefined;
  const parsed = parseCached(owner.filePath, owner.source);
  if (parsed.errors.some((error) => error.severity === "Error")) return undefined;
  const declaration = findDirectAbstraction(parsed.program, candidate);
  if (!declaration) return undefined;
  const ownerLiterals = literalsOf(declaration, owner.source);
  if (!ownerLiterals || ownerLiterals.length < 2) return undefined;
  const ownerName = declaration.id.name;

  const siblings = collectSiblingSets(owner.filePath, ownerName, ownerLiterals, projectFiles);
  if (siblings.length === 0) return undefined;
  const sibling = siblings
    .map((site) => ({
      site,
      shared: site.literals.filter((literal) => new Set(ownerLiterals).has(literal)).length,
    }))
    .sort((left, right) => right.shared - left.shared)[0]?.site;
  if (!sibling) return undefined;
  if (isDerived(ownerName, sibling.name, owner.source, projectFiles.find((file) => file.filePath === sibling.filePath)?.source ?? "")) {
    return undefined;
  }

  const siblingSet = new Set(sibling.literals);
  const ownerSet = new Set(ownerLiterals);
  const combined = new Set([...ownerLiterals, ...sibling.literals]);
  if (combined.size < 3) return undefined;
  return {
    owner: {
      name: ownerName,
      filePath: owner.filePath,
      source: candidate.source,
      literals: [...ownerSet],
    },
    sibling: {
      ...sibling,
      literals: [...siblingSet],
    },
    shared: [...ownerSet].filter((literal) => siblingSet.has(literal)),
    onlyInOwner: [...ownerSet].filter((literal) => !siblingSet.has(literal)),
    onlyInSibling: [...siblingSet].filter((literal) => !ownerSet.has(literal)),
    mappingFunction: findMappingFunction(ownerName, sibling.name, projectFiles),
  };
}
