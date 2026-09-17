import { parseSync, Visitor } from "oxc-parser";
import type { Candidate, ProjectFile } from "../types.js";
import { functionName } from "./repository.js";
import type { FunctionNode } from "./repository.js";

export type VerbUseEvidence = {
  verb: string;
  name: string;
  source: string;
};

export type SynonymClusterEvidence = {
  entity: string;
  verbs: VerbUseEvidence[];
};

export type SynonymVocabularyEvidence = {
  module: {
    filePath: string;
    source: string;
  };
  clusters: SynonymClusterEvidence[];
  functionCount: number;
};

function splitName(name: string): string[] {
  return name
    .replace(/([a-z0-9])([A-Z])/g, "$1 $2")
    .split(/[^A-Za-z0-9]+/)
    .map((part) => part.toLowerCase())
    .filter((part) => part.length > 0);
}

function verbAndEntity(name: string): { verb: string; entity: string } | undefined {
  const parts = splitName(name);
  if (parts.length < 2) return undefined;
  const [verb, ...rest] = parts;
  if (!verb) return undefined;
  const entity = rest.join("");
  if (entity.length < 2) return undefined;
  return { verb, entity };
}

function collectModuleFunctions(filePath: string, source: string): { name: string; source: string }[] {
  const parsed = parseSync(filePath, source, { range: true });
  if (parsed.errors.some((error) => error.severity === "Error")) return [];
  const result: { name: string; source: string }[] = [];
  const add = (node: FunctionNode): void => {
    const name = functionName(parsed.program, node);
    if (!name) return;
    result.push({ name, source: source.slice(node.start, node.end).slice(0, 2_000) });
  };
  new Visitor({
    ArrowFunctionExpression: add,
    FunctionDeclaration: add,
    FunctionExpression: add,
    MethodDefinition(node) {
      if (node.key.type !== "Identifier") return;
      result.push({ name: node.key.name, source: source.slice(node.start, node.end).slice(0, 2_000) });
    },
  }).visit(parsed.program);
  return result;
}

export function buildSynonymVocabularyEvidence(
  candidate: Candidate,
  projectFiles: ProjectFile[],
): SynonymVocabularyEvidence | undefined {
  if (candidate.kind !== "abstraction") return undefined;
  const owner = projectFiles.find((file) => file.filePath === candidate.filePath);
  if (!owner) return undefined;

  const functions = collectModuleFunctions(owner.filePath, owner.source);
  const byEntity = new Map<string, Map<string, VerbUseEvidence>>();
  for (const fn of functions) {
    const parsed = verbAndEntity(fn.name);
    if (!parsed) continue;
    const verbs = byEntity.get(parsed.entity) ?? new Map<string, VerbUseEvidence>();
    if (!verbs.has(parsed.verb)) {
      verbs.set(parsed.verb, { verb: parsed.verb, name: fn.name, source: fn.source });
    }
    byEntity.set(parsed.entity, verbs);
  }

  const clusters = [...byEntity.entries()]
    .filter(([, verbs]) => verbs.size >= 3)
    .map(([entity, verbs]) => ({
      entity,
      verbs: [...verbs.values()].sort((left, right) => left.verb.localeCompare(right.verb)).slice(0, 8),
    }))
    .sort((left, right) => right.verbs.length - left.verbs.length)
    .slice(0, 5);
  if (clusters.length === 0) return undefined;

  return {
    module: {
      filePath: owner.filePath,
      source: owner.source.slice(0, 16_000),
    },
    clusters,
    functionCount: functions.length,
  };
}
