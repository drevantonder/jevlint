import { Visitor } from "oxc-parser";
import { parseCached } from "./parse-cache.js";
import type { MemberExpression, TSType } from "oxc-parser";
import type { Candidate, ProjectFile } from "../types.js";
import {
  findStateModelDeclaration,
  findStateModelUsages,
  stateModelProperties,
  statePropertyName,
} from "./state-model.js";
import type { StateModelUsage } from "./state-model.js";

type DiscriminantEvidence = {
  name: string;
  cases: string[];
  source: string;
};

type LoosePropertyEvidence = {
  name: string;
  optional: boolean;
  nullable: boolean;
  source: string;
};

type CaseUseEvidence = {
  filePath: string;
  kind: "if" | "switch";
  discriminant: string;
  case: string;
  source: string;
  propertiesReferenced: string[];
};

export type ConditionallyValidStateEvidence = {
  stateType: {
    name: string;
    filePath: string;
    source: string;
    moduleSource: string;
  };
  discriminants: DiscriminantEvidence[];
  looseProperties: LoosePropertyEvidence[];
  caseUses: CaseUseEvidence[];
  typedUsages: StateModelUsage[];
};

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function literalCases(type: TSType, source: string): string[] {
  if (type.type !== "TSUnionType") return [];
  if (type.types.some((item) => item.type !== "TSLiteralType")) return [];
  return type.types.map((item) => source.slice(item.start, item.end));
}

function includesNullish(type: TSType): boolean {
  if (type.type === "TSNullKeyword" || type.type === "TSUndefinedKeyword") return true;
  return type.type === "TSUnionType" && type.types.some(includesNullish);
}

function memberPropertyName(member: MemberExpression): string | undefined {
  if (member.computed || member.property.type !== "Identifier") return undefined;
  return member.property.name;
}

function referencedProperties(source: string, properties: LoosePropertyEvidence[]): string[] {
  return properties.flatMap(({ name }) =>
    new RegExp(`\\b${escapeRegExp(name)}\\b`).test(source) ? [name] : []
  );
}

function casePattern(value: string): RegExp {
  const unquoted = value.startsWith("\"") || value.startsWith("'")
    ? value.slice(1, -1)
    : value;
  return new RegExp(`["']${escapeRegExp(unquoted)}["']`);
}

function addCaseUse(result: CaseUseEvidence[], evidence: CaseUseEvidence): void {
  if (result.some((item) =>
    item.filePath === evidence.filePath
    && item.kind === evidence.kind
    && item.discriminant === evidence.discriminant
    && item.case === evidence.case
    && item.source === evidence.source
  )) return;
  result.push(evidence);
}

function collectCaseUses(
  usages: StateModelUsage[],
  discriminants: DiscriminantEvidence[],
  looseProperties: LoosePropertyEvidence[],
): CaseUseEvidence[] {
  const result: CaseUseEvidence[] = [];
  const discriminantsByName = new Map(discriminants.map((item) => [item.name, item]));

  for (const usage of usages) {
    if (usage.kind !== "function") continue;
    const parsed = parseCached(usage.filePath, usage.source);
    if (parsed.errors.some((error) => error.severity === "Error")) continue;
    new Visitor({
      IfStatement(node) {
        const testSource = usage.source.slice(node.test.start, node.test.end);
        for (const discriminant of discriminants) {
          if (!new RegExp(`\\.${escapeRegExp(discriminant.name)}\\b`).test(testSource)) continue;
          const matchedCase = discriminant.cases.find((item) => casePattern(item).test(testSource));
          if (!matchedCase) continue;
          const branchSource = usage.source.slice(node.consequent.start, node.consequent.end);
          const properties = referencedProperties(branchSource, looseProperties);
          if (properties.length === 0) continue;
          addCaseUse(result, {
            filePath: usage.filePath,
            kind: "if",
            discriminant: discriminant.name,
            case: matchedCase,
            source: branchSource,
            propertiesReferenced: properties,
          });
        }
      },
      SwitchStatement(node) {
        if (node.discriminant.type !== "MemberExpression") return;
        const name = memberPropertyName(node.discriminant);
        const discriminant = name ? discriminantsByName.get(name) : undefined;
        if (!discriminant) return;
        for (const branch of node.cases) {
          if (!branch.test) continue;
          const branchCase = usage.source.slice(branch.test.start, branch.test.end);
          const declaredCase = discriminant.cases.find((item) => casePattern(item).test(branchCase));
          if (!declaredCase) continue;
          const branchSource = usage.source.slice(branch.start, branch.end);
          const properties = referencedProperties(branchSource, looseProperties);
          if (properties.length === 0) continue;
          addCaseUse(result, {
            filePath: usage.filePath,
            kind: "switch",
            discriminant: discriminant.name,
            case: declaredCase,
            source: branchSource,
            propertiesReferenced: properties,
          });
        }
      },
    }).visit(parsed.program);
  }
  return result.slice(0, 30);
}

export function buildConditionallyValidStateEvidence(
  candidate: Candidate,
  projectFiles: ProjectFile[],
): ConditionallyValidStateEvidence | undefined {
  if (candidate.kind !== "abstraction") return undefined;
  const owner = projectFiles.find((file) => file.filePath === candidate.filePath);
  if (!owner) return undefined;
  const parsed = parseCached(owner.filePath, owner.source);
  if (parsed.errors.some((error) => error.severity === "Error")) return undefined;
  const declaration = findStateModelDeclaration(parsed.program, candidate);
  if (!declaration) return undefined;
  const properties = stateModelProperties(declaration);

  const discriminants = properties.flatMap((property) => {
    const name = statePropertyName(property);
    const annotation = property.typeAnnotation?.typeAnnotation;
    if (!name || !annotation) return [];
    const cases = literalCases(annotation, owner.source);
    return cases.length >= 2
      ? [{ name, cases, source: owner.source.slice(property.start, property.end) }]
      : [];
  });
  if (discriminants.length === 0) return undefined;

  const discriminantNames = new Set(discriminants.map(({ name }) => name));
  const looseProperties = properties.flatMap((property) => {
    const name = statePropertyName(property);
    const annotation = property.typeAnnotation?.typeAnnotation;
    if (!name || !annotation || discriminantNames.has(name)) return [];
    const nullable = includesNullish(annotation);
    if (!property.optional && !nullable) return [];
    return [{
      name,
      optional: property.optional,
      nullable,
      source: owner.source.slice(property.start, property.end),
    }];
  });
  if (looseProperties.length === 0) return undefined;

  const name = declaration.id.name;
  const usageResult = findStateModelUsages(
    owner.filePath,
    name,
    [...discriminantNames, ...looseProperties.map(({ name: property }) => property)],
    projectFiles,
  );
  const caseUses = collectCaseUses(usageResult.usages, discriminants, looseProperties);
  if (caseUses.length === 0) return undefined;

  return {
    stateType: {
      name,
      filePath: owner.filePath,
      source: candidate.source,
      moduleSource: owner.source.slice(0, 16_000),
    },
    discriminants,
    looseProperties,
    caseUses,
    typedUsages: usageResult.usages,
  };
}
