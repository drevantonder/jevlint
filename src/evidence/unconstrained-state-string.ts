import { Visitor } from "oxc-parser";
import { parseCached } from "./parse-cache.js";
import type { Expression, MemberExpression } from "oxc-parser";
import type { Candidate, ProjectFile } from "../types.js";
import {
  findStateModelDeclaration,
  findStateModelUsages,
  stateModelProperties,
  statePropertyName,
} from "./state-model.js";
import type { StateModelUsage } from "./state-model.js";

type StringPropertyEvidence = {
  name: string;
  optional: boolean;
  readonly: boolean;
  source: string;
};

type StateDecisionEvidence = {
  filePath: string;
  kind: "comparison" | "switch";
  source: string;
  literals: string[];
};

type StateTransitionEvidence = {
  filePath: string;
  source: string;
  literal: string;
};

type FiniteStateUseEvidence = {
  property: string;
  literals: string[];
  decisions: StateDecisionEvidence[];
  transitions: StateTransitionEvidence[];
};

export type UnconstrainedStateStringEvidence = {
  stateType: {
    name: string;
    filePath: string;
    source: string;
    moduleSource: string;
  };
  stringProperties: StringPropertyEvidence[];
  finiteStateUses: FiniteStateUseEvidence[];
  typedUsages: StateModelUsage[];
};

function memberPropertyName(member: MemberExpression): string | undefined {
  if (member.computed || member.property.type !== "Identifier") return undefined;
  return member.property.name;
}

function matchingMemberProperty(
  expression: Expression,
  propertyNames: Set<string>,
): string | undefined {
  if (expression.type !== "MemberExpression") return undefined;
  const name = memberPropertyName(expression);
  return name && propertyNames.has(name) ? name : undefined;
}

function quotedLiteral(expression: Expression | null, source: string): string | undefined {
  if (!expression || expression.type !== "Literal") return undefined;
  const literal = source.slice(expression.start, expression.end);
  return literal.startsWith("\"") || literal.startsWith("'") ? literal : undefined;
}

function addDecision(
  decisions: Map<string, StateDecisionEvidence[]>,
  property: string,
  decision: StateDecisionEvidence,
): void {
  const existing = decisions.get(property) ?? [];
  if (!existing.some((item) =>
    item.filePath === decision.filePath
    && item.kind === decision.kind
    && item.source === decision.source
  )) existing.push(decision);
  decisions.set(property, existing);
}

function addTransition(
  transitions: Map<string, StateTransitionEvidence[]>,
  property: string,
  transition: StateTransitionEvidence,
): void {
  const existing = transitions.get(property) ?? [];
  if (!existing.some((item) =>
    item.filePath === transition.filePath && item.source === transition.source
  )) existing.push(transition);
  transitions.set(property, existing);
}

function collectFiniteStateUses(
  usages: StateModelUsage[],
  propertyNames: string[],
): FiniteStateUseEvidence[] {
  const decisions = new Map<string, StateDecisionEvidence[]>();
  const transitions = new Map<string, StateTransitionEvidence[]>();
  const properties = new Set(propertyNames);

  for (const usage of usages) {
    if (usage.kind !== "function") continue;
    const parsed = parseCached(usage.filePath, usage.source);
    if (parsed.errors.some((error) => error.severity === "Error")) continue;
    new Visitor({
      BinaryExpression(node) {
        if (!["===", "!==", "==", "!="].includes(node.operator)) return;
        const leftProperty = matchingMemberProperty(node.left, properties);
        const rightProperty = matchingMemberProperty(node.right, properties);
        const property = leftProperty ?? rightProperty;
        const literal = leftProperty
          ? quotedLiteral(node.right, usage.source)
          : rightProperty
            ? quotedLiteral(node.left, usage.source)
            : undefined;
        if (!property || !literal) return;
        addDecision(decisions, property, {
          filePath: usage.filePath,
          kind: "comparison",
          source: usage.source.slice(node.start, node.end),
          literals: [literal],
        });
      },
      SwitchStatement(node) {
        const property = matchingMemberProperty(node.discriminant, properties);
        if (!property) return;
        const literals = node.cases.flatMap((item) => {
          const literal = quotedLiteral(item.test, usage.source);
          return literal ? [literal] : [];
        });
        if (literals.length === 0) return;
        addDecision(decisions, property, {
          filePath: usage.filePath,
          kind: "switch",
          source: usage.source.slice(node.start, node.end),
          literals,
        });
      },
      AssignmentExpression(node) {
        const assignedProperty = node.left.type === "MemberExpression"
          ? memberPropertyName(node.left)
          : undefined;
        const property = assignedProperty && properties.has(assignedProperty)
          ? assignedProperty
          : undefined;
        const literal = quotedLiteral(node.right, usage.source);
        if (!property || !literal) return;
        addTransition(transitions, property, {
          filePath: usage.filePath,
          source: usage.source.slice(node.start, node.end),
          literal,
        });
      },
    }).visit(parsed.program);
  }

  return propertyNames.flatMap((property) => {
    const propertyDecisions = decisions.get(property) ?? [];
    const decisionLiterals = new Set(propertyDecisions.flatMap(({ literals }) => literals));
    if (decisionLiterals.size < 2) return [];
    const propertyTransitions = transitions.get(property) ?? [];
    return [{
      property,
      literals: [...new Set([
        ...decisionLiterals,
        ...propertyTransitions.map(({ literal }) => literal),
      ])],
      decisions: propertyDecisions.slice(0, 20),
      transitions: propertyTransitions.slice(0, 20),
    }];
  });
}

export function buildUnconstrainedStateStringEvidence(
  candidate: Candidate,
  projectFiles: ProjectFile[],
): UnconstrainedStateStringEvidence | undefined {
  if (candidate.kind !== "abstraction") return undefined;
  const owner = projectFiles.find((file) => file.filePath === candidate.filePath);
  if (!owner) return undefined;
  const parsed = parseCached(owner.filePath, owner.source);
  if (parsed.errors.some((error) => error.severity === "Error")) return undefined;
  const declaration = findStateModelDeclaration(parsed.program, candidate);
  if (!declaration) return undefined;

  const stringProperties = stateModelProperties(declaration).flatMap((property) => {
    const name = statePropertyName(property);
    if (!name || property.typeAnnotation?.typeAnnotation.type !== "TSStringKeyword") return [];
    return [{
      name,
      optional: property.optional,
      readonly: property.readonly,
      source: owner.source.slice(property.start, property.end),
    }];
  });
  if (stringProperties.length === 0) return undefined;

  const name = declaration.id.name;
  const usageResult = findStateModelUsages(
    owner.filePath,
    name,
    stringProperties.map((property) => property.name),
    projectFiles,
  );
  const finiteStateUses = collectFiniteStateUses(
    usageResult.usages,
    stringProperties.map((property) => property.name),
  );
  if (finiteStateUses.length === 0) return undefined;
  const finiteStateProperties = new Set(finiteStateUses.map(({ property }) => property));

  return {
    stateType: {
      name,
      filePath: owner.filePath,
      source: candidate.source,
      moduleSource: owner.source.slice(0, 16_000),
    },
    stringProperties: stringProperties.filter(({ name: property }) =>
      finiteStateProperties.has(property)
    ),
    finiteStateUses,
    typedUsages: usageResult.usages,
  };
}
