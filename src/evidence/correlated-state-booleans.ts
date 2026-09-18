import { parseCached } from "./parse-cache.js";
import type { Candidate, ProjectFile } from "../types.js";
import {
  findStateModelDeclaration,
  findStateModelUsages,
  stateModelProperties,
  statePropertyName,
} from "./state-model.js";
import type { StateModelUsage } from "./state-model.js";

type BooleanPropertyEvidence = {
  name: string;
  optional: boolean;
  readonly: boolean;
  source: string;
};

export type CorrelatedStateBooleansEvidence = {
  stateType: {
    name: string;
    filePath: string;
    source: string;
    moduleSource: string;
  };
  booleanProperties: BooleanPropertyEvidence[];
  usages: StateModelUsage[];
  coverage: {
    projectFiles: number;
    filesWithTypedUsage: number;
    usagesFound: number;
    usagesIncluded: number;
    truncatedUsages: number;
  };
};

export function buildCorrelatedStateBooleansEvidence(
  candidate: Candidate,
  projectFiles: ProjectFile[],
): CorrelatedStateBooleansEvidence | undefined {
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
  if (booleanProperties.length < 2) return undefined;

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
    usages: usageResult.usages,
    coverage: {
      projectFiles: projectFiles.length,
      filesWithTypedUsage: usageResult.files,
      usagesFound: usageResult.total,
      usagesIncluded: usageResult.usages.length,
      truncatedUsages: usageResult.usages.filter(({ truncated }) => truncated).length,
    },
  };
}
