import type { TSType } from "oxc-parser";
import { parseCached } from "./parse-cache.js";
import type { AbstractionNode } from "./repository.js";
import type { Candidate, ProjectFile } from "../types.js";
import {
  findDirectAbstraction,
  moduleImports,
  resolveModule,
} from "./repository.js";

export type CardinalityMorphology = {
  token: string;
  form: "plural" | "singular" | "exempt";
  asserted: "collection" | "single" | "none";
  conventionalBag: boolean;
};

export type DeclaredCardinality = {
  form: "collection" | "single" | "unknown";
  detail: string;
};

export type CardinalityUsage = {
  filePath: string;
  line: number;
  source: string;
};

export type CardinalityLyingTypeEvidence = {
  abstraction: {
    name: string;
    kind: "interface" | "type";
    filePath: string;
    source: string;
  };
  morphology: CardinalityMorphology;
  declared: DeclaredCardinality;
  mismatch: "plural-name-single-shape" | "singular-name-collection-shape";
  established: boolean;
  usages: CardinalityUsage[];
  importingModules: string[];
};

const MAX_USAGES = 8;
const ESTABLISHED_FILE_COUNT = 2;

// Mass nouns promise no number, so they can never lie about cardinality.
const UNCOUNTABLE = new Set([
  "data",
  "metadata",
  "info",
  "information",
  "feedback",
  "software",
  "hardware",
  "knowledge",
  "progress",
  "research",
  "advice",
  "media",
  "content",
]);

// Plural-looking words the language already treats as singular concepts.
const CONVENTIONAL_SINGULAR = new Set([
  "news",
  "series",
  "species",
  "status",
  "alias",
  "bias",
  "canvas",
  "bus",
  "campus",
  "chorus",
  "circus",
  "bonus",
  "virus",
  "apparatus",
  "census",
  "consensus",
  "focus",
  "hiatus",
  "nexus",
  "opus",
  "lotus",
  "plus",
  "lens",
  "atlas",
  "chaos",
  "cosmos",
]);

// Plural-looking bags a codebase may adopt as singular concepts (Settings).
// These still fire until the codebase shows they are established convention.
const CONVENTIONAL_BAGS = new Set(["settings"]);

const IRREGULAR_PLURALS = new Set([
  "children",
  "people",
  "men",
  "women",
  "teeth",
  "feet",
  "mice",
  "geese",
  "oxen",
  "lice",
  "indices",
  "vertices",
  "matrices",
  "criteria",
  "phenomena",
  "alumni",
  "fungi",
  "cacti",
  "syllabi",
  "larvae",
]);

const COLLECTION_TYPE_NAMES = new Set([
  "Array",
  "ReadonlyArray",
  "Set",
  "ReadonlySet",
  "Map",
  "ReadonlyMap",
  "WeakSet",
  "WeakMap",
  "Record",
]);

const TRANSPARENT_WRAPPERS = new Set([
  "Readonly",
  "NonNullable",
  "Promise",
  "Awaited",
]);

const OBJECT_WRAPPERS = new Set(["Partial", "Required", "Pick", "Omit"]);

function lastToken(name: string): string {
  const tokens = name.match(/[A-Z]?[a-z]+|[A-Z]+(?![a-z])|\d+/g);
  if (!tokens || tokens.length === 0) return name;
  return tokens[tokens.length - 1] ?? name;
}

function classifyMorphology(name: string): CardinalityMorphology {
  const token = lastToken(name);
  const lower = token.toLowerCase();
  const conventionalBag = CONVENTIONAL_BAGS.has(lower);
  if (name.length <= 1 || UNCOUNTABLE.has(lower) || CONVENTIONAL_SINGULAR.has(lower)) {
    return { token, form: "exempt", asserted: "none", conventionalBag };
  }
  if (
    IRREGULAR_PLURALS.has(lower)
    || (lower.length > 3 && lower.endsWith("ies"))
    || /(ses|xes|zes|ches|shes)$/.test(lower)
    || (lower.length > 3 && lower.endsWith("s") && !lower.endsWith("ss")
      && !lower.endsWith("is") && !lower.endsWith("ics"))
  ) {
    return { token, form: "plural", asserted: "collection", conventionalBag };
  }
  return { token, form: "singular", asserted: "single", conventionalBag };
}

function referenceName(type: TSType): string | undefined {
  if (type.type !== "TSTypeReference") return undefined;
  const { typeName } = type;
  if (typeName.type === "Identifier") return typeName.name;
  return undefined;
}

function firstTypeArgument(type: TSType): TSType | undefined {
  if (type.type !== "TSTypeReference") return undefined;
  return type.typeArguments?.params[0];
}

function classifyDeclared(type: TSType): DeclaredCardinality {
  switch (type.type) {
    case "TSArrayType":
      return { form: "collection", detail: "array" };
    case "TSTupleType":
      return { form: "collection", detail: "tuple" };
    case "TSUnionType":
      // A union of members reads as "many" to some readers; record the
      // detail and let the evaluation weigh the reading.
      return { form: "single", detail: "union" };
    case "TSIntersectionType":
      return { form: "unknown", detail: "intersection" };
    case "TSTypeLiteral":
      return type.members.some((member) => member.type === "TSIndexSignature")
        ? { form: "collection", detail: "index-signature" }
        : { form: "single", detail: "object" };
    case "TSFunctionType":
    case "TSConstructorType":
      return { form: "single", detail: "function" };
    case "TSLiteralType":
    case "TSNumberKeyword":
    case "TSStringKeyword":
    case "TSBooleanKeyword":
    case "TSBigIntKeyword":
    case "TSSymbolKeyword":
    case "TSObjectKeyword":
    case "TSVoidKeyword":
    case "TSUndefinedKeyword":
    case "TSNullKeyword":
    case "TSNeverKeyword":
    case "TSUnknownKeyword":
    case "TSAnyKeyword":
    case "TSIntrinsicKeyword":
    case "TSTemplateLiteralType":
      return { form: "single", detail: "primitive" };
    case "TSMappedType":
      return { form: "single", detail: "mapped" };
    case "TSParenthesizedType":
      return classifyDeclared(type.typeAnnotation);
    case "TSTypeOperator":
      return type.operator === "keyof" ? { form: "unknown", detail: "keyof" } : classifyDeclared(type.typeAnnotation);
    case "TSTypeReference": {
      const target = referenceName(type);
      if (!target) return { form: "unknown", detail: "qualified-reference" };
      if (COLLECTION_TYPE_NAMES.has(target)) return { form: "collection", detail: target };
      if (OBJECT_WRAPPERS.has(target)) return { form: "single", detail: target };
      if (TRANSPARENT_WRAPPERS.has(target)) {
        const inner = firstTypeArgument(type);
        return inner ? classifyDeclared(inner) : { form: "unknown", detail: target };
      }
      return { form: "unknown", detail: `reference-to-${target}` };
    }
    default:
      return { form: "unknown", detail: type.type };
  }
}

function declaredCardinality(node: AbstractionNode, source: string): DeclaredCardinality {
  if (node.type !== "TSInterfaceDeclaration") return classifyDeclared(node.typeAnnotation);
  for (const heritage of node.extends) {
    const text = source.slice(heritage.expression.start, heritage.expression.end);
    if (COLLECTION_TYPE_NAMES.has(text)) return { form: "collection", detail: `extends-${text}` };
  }
  return node.body.body.some((member) => member.type === "TSIndexSignature")
    ? { form: "collection", detail: "index-signature" }
    : { form: "single", detail: "object" };
}

function lineAt(source: string, offset: number): number {
  let line = 1;
  for (let index = 0; index < offset; index += 1) {
    if (source[index] === "\n") line += 1;
  }
  return line;
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

export type TypeUsages = {
  usages: CardinalityUsage[];
  importingModules: string[];
};

function collectUsages(
  ownerPath: string,
  typeName: string,
  projectFiles: ProjectFile[],
): TypeUsages {
  const pattern = new RegExp(`\\b${escapeRegExp(typeName)}\\b`);
  const usages: CardinalityUsage[] = [];
  const importingModules = new Set<string>();
  for (const file of projectFiles) {
    if (file.filePath === ownerPath) continue;
    const parsed = parseCached(file.filePath, file.source);
    if (parsed.errors.some((error) => error.severity === "Error")) continue;
    if (moduleImports(parsed.program).some((imported) =>
      imported.imported === typeName
      && resolveModule(file.filePath, imported.source, projectFiles)?.filePath === ownerPath
    )) {
      importingModules.add(file.filePath);
    }
    if (usages.length >= MAX_USAGES || !pattern.test(file.source)) continue;
    const offset = file.source.search(pattern);
    usages.push({
      filePath: file.filePath,
      line: lineAt(file.source, offset),
      source: file.source.slice(Math.max(0, offset - 80), offset + 120)
        .replaceAll(/\s+/g, " ").trim().slice(0, 300),
    });
  }
  return { usages, importingModules: [...importingModules].sort().slice(0, 12) };
}

export function buildCardinalityLyingTypeEvidence(
  candidate: Candidate,
  projectFiles: ProjectFile[],
): CardinalityLyingTypeEvidence | undefined {
  if (candidate.kind !== "abstraction") return undefined;
  const owner = projectFiles.find((file) => file.filePath === candidate.filePath);
  if (!owner) return undefined;
  const parsed = parseCached(owner.filePath, owner.source);
  if (parsed.errors.some((error) => error.severity === "Error")) return undefined;
  const node = findDirectAbstraction(parsed.program, candidate);
  if (!node) return undefined;

  const name = node.id.name;
  if (!name) return undefined;
  const morphology = classifyMorphology(name);
  if (morphology.form === "exempt") return undefined;
  const declared = declaredCardinality(node, owner.source);
  if (declared.form === "unknown") return undefined;

  const { usages, importingModules } = collectUsages(owner.filePath, name, projectFiles);
  const referencingFiles = new Set([
    ...importingModules,
    ...usages.map((usage) => usage.filePath),
  ]);
  const established = referencingFiles.size >= ESTABLISHED_FILE_COUNT;
  if (morphology.conventionalBag && established) return undefined;

  const mismatch = morphology.form === "plural" && declared.form === "single"
    ? "plural-name-single-shape"
    : morphology.form === "singular" && declared.form === "collection"
      ? "singular-name-collection-shape"
      : undefined;
  if (!mismatch) return undefined;

  return {
    abstraction: {
      name,
      kind: node.type === "TSInterfaceDeclaration" ? "interface" : "type",
      filePath: owner.filePath,
      source: candidate.source,
    },
    morphology,
    declared,
    mismatch,
    established,
    usages,
    importingModules,
  };
}
