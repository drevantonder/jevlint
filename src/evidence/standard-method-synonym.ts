import { Visitor } from "oxc-parser";
import { parseCached } from "./parse-cache.js";
import type { Candidate, ProjectFile } from "../types.js";
import { functionName, isFunctionExported } from "./repository.js";
import type { FunctionNode } from "./repository.js";

export type StandardMethodVerbUse = {
  verb: string;
  name: string;
  filePath: string;
  exported: boolean;
  source: string;
};

export type StandardMethodSynonymPair = {
  stem: string;
  verbs: StandardMethodVerbUse[];
};

export type StandardMethodSynonymEvidence = {
  module: {
    filePath: string;
    source: string;
  };
  pairs: StandardMethodSynonymPair[];
  fileCount: number;
  functionCount: number;
};

// Read-concept verbs of the standard-method family (AIP-131 Get / AIP-132
// List and their everyday synonyms). Verbs outside this family, such as
// create, update, or delete, are distinct standard methods, not synonyms.
const READ_FAMILY = new Set([
  "get",
  "list",
  "fetch",
  "retrieve",
  "load",
  "read",
  "query",
  "find",
]);

function splitName(name: string): string[] {
  return name
    .replace(/([a-z0-9])([A-Z])/g, "$1 $2")
    .split(/[^A-Za-z0-9]+/)
    .map((part) => part.toLowerCase())
    .filter((part) => part.length > 0);
}

function verbAndStem(name: string): { verb: string; stem: string } | undefined {
  const parts = splitName(name);
  if (parts.length < 2) return undefined;
  const [verb, ...rest] = parts;
  if (!verb || !READ_FAMILY.has(verb)) return undefined;
  const stem = rest.join("");
  if (stem.length < 2) return undefined;
  return { verb, stem };
}

function collectExportedOperations(
  filePath: string,
  source: string,
): { name: string; source: string }[] {
  const parsed = parseCached(filePath, source);
  if (parsed.errors.some((error) => error.severity === "Error")) return [];
  const result: { name: string; source: string }[] = [];
  const add = (node: FunctionNode): void => {
    const name = functionName(parsed.program, node);
    if (!name) return;
    if (!isFunctionExported(parsed.program, node, name)) return;
    result.push({ name, source: source.slice(node.start, node.end).slice(0, 2_000) });
  };
  const visitor = new Visitor({
    ArrowFunctionExpression: add,
    FunctionDeclaration: add,
    FunctionExpression: add,
  });
  visitor.visit(parsed.program);
  const exportedClassRanges: { start: number; end: number }[] = [];
  const classRanges = new Map<string, { start: number; end: number }>();
  for (const statement of parsed.program.body) {
    if (statement.type === "ClassDeclaration" && statement.id) {
      classRanges.set(statement.id.name, statement);
    }
    const declaration = statement.type === "ExportNamedDeclaration"
      ? statement.declaration
      : statement.type === "ExportDefaultDeclaration"
        ? statement.declaration
        : undefined;
    if (declaration?.type === "ClassDeclaration") {
      exportedClassRanges.push(declaration);
    }
    if (statement.type === "ExportNamedDeclaration") {
      for (const specifier of statement.specifiers) {
        if (specifier.local.type !== "Identifier") continue;
        const range = classRanges.get(specifier.local.name);
        if (range) exportedClassRanges.push(range);
      }
    }
  }
  new Visitor({
    MethodDefinition(node) {
      if (node.key.type !== "Identifier") return;
      if (!exportedClassRanges.some((range) => range.start <= node.start && range.end >= node.end)) return;
      result.push({
        name: node.key.name,
        source: source.slice(node.start, node.end).slice(0, 2_000),
      });
    },
  }).visit(parsed.program);
  return result;
}

export function buildStandardMethodSynonymEvidence(
  candidate: Candidate,
  projectFiles: ProjectFile[],
): StandardMethodSynonymEvidence | undefined {
  if (candidate.kind !== "abstraction") return undefined;
  const owner = projectFiles.find((file) => file.filePath === candidate.filePath);
  if (!owner) return undefined;

  const byStem = new Map<string, Map<string, StandardMethodVerbUse>>();
  let functionCount = 0;
  for (const file of projectFiles) {
    const operations = collectExportedOperations(file.filePath, file.source);
    functionCount += operations.length;
    for (const operation of operations) {
      const parsed = verbAndStem(operation.name);
      if (!parsed) continue;
      const verbs = byStem.get(parsed.stem) ?? new Map<string, StandardMethodVerbUse>();
      if (!verbs.has(parsed.verb)) {
        verbs.set(parsed.verb, {
          verb: parsed.verb,
          name: operation.name,
          filePath: file.filePath,
          exported: true,
          source: operation.source,
        });
      }
      byStem.set(parsed.stem, verbs);
    }
  }

  const pairs = [...byStem.entries()]
    .filter(([, verbs]) => verbs.size >= 2)
    .map(([stem, verbs]) => ({
      stem,
      verbs: [...verbs.values()].sort((left, right) => left.verb.localeCompare(right.verb)).slice(0, 8),
    }))
    .sort((left, right) => right.verbs.length - left.verbs.length)
    .slice(0, 5);
  if (pairs.length === 0) return undefined;

  return {
    module: {
      filePath: owner.filePath,
      source: owner.source.slice(0, 16_000),
    },
    pairs,
    fileCount: projectFiles.length,
    functionCount,
  };
}
