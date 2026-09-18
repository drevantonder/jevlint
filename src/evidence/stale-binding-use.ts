import { Visitor } from "oxc-parser";
import { parseCached } from "./parse-cache.js";
import type { Expression, PrivateIdentifier } from "oxc-parser";
import type { Candidate, ProjectFile } from "../types.js";
import {
  findDirectFunction,
  findFunctionCallers,
  functionName,
  isFunctionExported,
  nestedFunctionRanges,
} from "./repository.js";
import type { FunctionCaller, FunctionNode } from "./repository.js";

export type StaleUse = {
  expression: string;
  kind: "return" | "argument";
  staleBinding: string;
  discardedDerivation: string;
};

export type DerivedBinding = {
  name: string;
  derivation: string;
  derivedFrom: string[];
  usedLater: boolean;
};

export type StaleBindingUseEvidence = {
  function: {
    name: string;
    exported: boolean;
    filePath: string;
    source: string;
  };
  staleUses: StaleUse[];
  derivedBindings: DerivedBinding[];
  callers: FunctionCaller[];
};

function identifiersIn(expression: Expression | PrivateIdentifier, into: Set<string>): void {
  if (expression.type === "Identifier") {
    into.add(expression.name);
    return;
  }
  if (expression.type === "MemberExpression") {
    identifiersIn(expression.object, into);
    if (expression.computed) identifiersIn(expression.property, into);
    return;
  }
  if (expression.type === "CallExpression") {
    identifiersIn(expression.callee, into);
    for (const argument of expression.arguments) {
      if (argument.type === "SpreadElement") identifiersIn(argument.argument, into);
      else identifiersIn(argument, into);
    }
    return;
  }
  if (expression.type === "ObjectExpression") {
    for (const property of expression.properties) {
      if (property.type === "Property") identifiersIn(property.value, into);
      if (property.type === "SpreadElement") identifiersIn(property.argument, into);
    }
    return;
  }
  if (expression.type === "ArrayExpression") {
    for (const element of expression.elements) {
      if (!element || element.type === "SpreadElement") {
        if (element) identifiersIn(element.argument, into);
        continue;
      }
      identifiersIn(element, into);
    }
    return;
  }
  if (
    expression.type === "BinaryExpression"
    || expression.type === "LogicalExpression"
  ) {
    identifiersIn(expression.left, into);
    identifiersIn(expression.right, into);
    return;
  }
  if (expression.type === "UnaryExpression" || expression.type === "UpdateExpression") {
    identifiersIn(expression.argument, into);
    return;
  }
  if (expression.type === "ConditionalExpression") {
    identifiersIn(expression.test, into);
    identifiersIn(expression.consequent, into);
    identifiersIn(expression.alternate, into);
    return;
  }
  if (expression.type === "TemplateLiteral") {
    for (const part of expression.expressions) identifiersIn(part, into);
    return;
  }
  if (expression.type === "NewExpression") {
    identifiersIn(expression.callee, into);
    for (const argument of expression.arguments) {
      if (argument.type === "SpreadElement") identifiersIn(argument.argument, into);
      else identifiersIn(argument, into);
    }
    return;
  }
  if (expression.type === "AwaitExpression") {
    identifiersIn(expression.argument, into);
    return;
  }
  if (expression.type === "ChainExpression") {
    identifiersIn(expression.expression, into);
    return;
  }
  if (
    expression.type === "TSAsExpression"
    || expression.type === "TSNonNullExpression"
    || expression.type === "TSSatisfiesExpression"
    || expression.type === "TSTypeAssertion"
  ) {
    identifiersIn(expression.expression, into);
  }
}

function bindingName(parameter: FunctionNode["params"][number]): string | undefined {
  const value = parameter.type === "TSParameterProperty" ? parameter.parameter : parameter;
  if (value.type === "Identifier") return value.name;
  if (value.type === "AssignmentPattern" && value.left.type === "Identifier") {
    return value.left.name;
  }
  if (value.type === "RestElement" && value.argument.type === "Identifier") {
    return value.argument.name;
  }
  return undefined;
}

export function buildStaleBindingUseEvidence(
  candidate: Candidate,
  projectFiles: ProjectFile[],
): StaleBindingUseEvidence | undefined {
  if (candidate.kind !== "function") return undefined;
  const owner = projectFiles.find((file) => file.filePath === candidate.filePath);
  if (!owner) return undefined;
  const parsed = parseCached(owner.filePath, owner.source);
  if (parsed.errors.some((error) => error.severity === "Error")) return undefined;
  const fn = findDirectFunction(parsed.program, candidate);
  if (!fn) return undefined;
  const name = functionName(parsed.program, fn);
  if (!name) return undefined;

  const nested = nestedFunctionRanges(parsed.program, candidate);
  const direct = (node: { start: number; end: number }): boolean =>
    node.start >= candidate.start
    && node.end <= candidate.end
    && !nested.some((range) => range.start <= node.start && range.end >= node.end);

  const scope = new Set<string>();
  for (const parameter of fn.params) {
    const parameterName = bindingName(parameter);
    if (parameterName) scope.add(parameterName);
  }

  type Declarator = {
    name: string;
    start: number;
    derivedFrom: string[];
    derivation: string;
  };
  const declarators: Declarator[] = [];
  new Visitor({
    VariableDeclarator(node) {
      if (!direct(node) || node.id.type !== "Identifier" || !node.init) return;
      scope.add(node.id.name);
      const referenced = new Set<string>();
      identifiersIn(node.init, referenced);
      referenced.delete(node.id.name);
      const derivedFrom = [...referenced].filter((identifier) => scope.has(identifier));
      if (derivedFrom.length === 0) return;
      declarators.push({
        name: node.id.name,
        start: node.start,
        derivedFrom,
        derivation: owner.source.slice(node.init.start, node.init.end),
      });
    },
  }).visit(parsed.program);

  if (declarators.length === 0) return undefined;

  const usesAfter = new Map<string, number[]>();
  new Visitor({
    Identifier(node) {
      if (!direct(node)) return;
      const positions = usesAfter.get(node.name) ?? [];
      positions.push(node.start);
      usesAfter.set(node.name, positions);
    },
  }).visit(parsed.program);

  const derived: DerivedBinding[] = declarators.map((declarator) => {
    const positions = usesAfter.get(declarator.name) ?? [];
    return {
      name: declarator.name,
      derivation: declarator.derivation,
      derivedFrom: declarator.derivedFrom,
      usedLater: positions.some((position) => position > declarator.start),
    };
  });

  const stale = derived.filter((binding) => !binding.usedLater);
  if (stale.length === 0) return undefined;

  const staleUses: StaleUse[] = [];
  const declaratorStart = new Map(declarators.map((declarator) => [declarator.name, declarator.start]));
  const consider = (
    expression: Expression,
    kind: "return" | "argument",
    start: number,
  ): void => {
    const mentioned = new Set<string>();
    identifiersIn(expression, mentioned);
    for (const binding of stale) {
      if (start < (declaratorStart.get(binding.name) ?? 0)) continue;
      const overlap = binding.derivedFrom.filter((source) => mentioned.has(source));
      if (overlap.length === 0) continue;
      staleUses.push({
        expression: owner.source.slice(expression.start, expression.end),
        kind,
        staleBinding: overlap.join(", "),
        discardedDerivation: binding.name,
      });
    }
  };
  new Visitor({
    ReturnStatement(node) {
      if (!direct(node) || !node.argument) return;
      consider(node.argument, "return", node.start);
    },
    CallExpression(node) {
      if (!direct(node)) return;
      for (const argument of node.arguments) {
        if (argument.type === "SpreadElement") consider(argument.argument, "argument", node.start);
        else consider(argument, "argument", node.start);
      }
    },
  }).visit(parsed.program);

  if (staleUses.length === 0) return undefined;
  return {
    function: {
      name,
      exported: isFunctionExported(parsed.program, fn, name),
      filePath: owner.filePath,
      source: candidate.source,
    },
    staleUses,
    derivedBindings: derived,
    callers: findFunctionCallers(candidate.filePath, name, projectFiles),
  };
}
