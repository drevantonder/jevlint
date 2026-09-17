import { parseSync, Visitor } from "oxc-parser";
import type { Expression, Node } from "oxc-parser";
import type { Candidate, ProjectFile } from "../types.js";
import {
  belongsDirectlyToFunction,
  containsNode,
  nestedFunctionRanges,
} from "./function-scope.js";
import type { NodeRange } from "./function-scope.js";
import {
  findDirectFunction,
  findFunctionCallers,
  functionName,
  isFunctionExported,
} from "./repository.js";
import type { FunctionCaller, FunctionNode } from "./repository.js";

type AssumptionKind = "index-access" | "key-access" | "division" | "destructuring";

type PreconditionAssumption = {
  parameter: string;
  kind: AssumptionKind;
  operation: string;
  guarded: boolean;
};

type SourceRange = {
  start: number;
  end: number;
};

export type UncheckedPreconditionEvidence = {
  function: {
    name: string | null;
    exported: boolean;
    filePath: string;
    source: string;
    moduleSource: string;
    parameters: string[];
  };
  assumptions: PreconditionAssumption[];
  guards: string[];
  repository: {
    callers: FunctionCaller[];
  };
};

function nodeSource(node: Node, source: string): string {
  return source.slice(node.start, node.end);
}

const NUMERIC_RAW_PATTERN = /^[-\d.]/;

function isNumericRaw(raw: string | null): boolean {
  return raw !== null && NUMERIC_RAW_PATTERN.test(raw);
}

function parameterNames(fn: FunctionNode): Set<string> {
  const names = new Set<string>();
  for (const parameter of fn.params) {
    const value = parameter.type === "TSParameterProperty" ? parameter.parameter : parameter;
    if (value.type === "Identifier") names.add(value.name);
    else if (value.type === "AssignmentPattern" && value.left.type === "Identifier") {
      names.add(value.left.name);
    } else if (value.type === "RestElement" && value.argument.type === "Identifier") {
      names.add(value.argument.name);
    }
  }
  return names;
}

function rootIdentifier(expression: Expression): string | undefined {
  if (expression.type === "Identifier") return expression.name;
  if (expression.type === "MemberExpression") {
    return expression.object.type === "Super" ? undefined : rootIdentifier(expression.object);
  }
  if (expression.type === "ChainExpression") return rootIdentifier(expression.expression);
  if (
    expression.type === "TSAsExpression"
    || expression.type === "TSNonNullExpression"
    || expression.type === "TSSatisfiesExpression"
    || expression.type === "TSTypeAssertion"
  ) return rootIdentifier(expression.expression);
  return undefined;
}

function mentionsName(range: NodeRange, program: Parameters<Visitor["visit"]>[0], name: string): boolean {
  let mentioned = false;
  new Visitor({
    Identifier(node) {
      if (node.name === name && containsNode(range, node)) mentioned = true;
    },
  }).visit(program);
  return mentioned;
}

export function buildUncheckedPreconditionEvidence(
  candidate: Candidate,
  projectFiles: ProjectFile[],
): UncheckedPreconditionEvidence | undefined {
  if (candidate.kind !== "function") return undefined;
  const ownerFile = projectFiles.find((file) => file.filePath === candidate.filePath);
  if (!ownerFile) return undefined;
  const parsed = parseSync(ownerFile.filePath, ownerFile.source, { range: true });
  if (parsed.errors.some((error) => error.severity === "Error")) return undefined;
  const fn: FunctionNode | undefined = findDirectFunction(parsed.program, candidate);
  if (!fn) return undefined;
  const parameters = parameterNames(fn);
  if (parameters.size === 0) return undefined;

  const nested = nestedFunctionRanges(parsed.program, fn);
  const inScope = (node: NodeRange): boolean =>
    node.start >= fn.start && node.end <= fn.end && belongsDirectlyToFunction(node, nested);

  const assumptions: Array<PreconditionAssumption & SourceRange> = [];
  new Visitor({
    MemberExpression(node) {
      if (!inScope(node) || !node.computed) return;
      const root = rootIdentifier(node.object);
      if (!root || !parameters.has(root)) return;
      const property = node.property;
      if (property.type === "Literal" && isNumericRaw(property.raw)) {
        assumptions.push({
          parameter: root,
          kind: "index-access",
          operation: nodeSource(node, ownerFile.source),
          guarded: false,
          start: node.start,
          end: node.end,
        });
      } else {
        assumptions.push({
          parameter: root,
          kind: "key-access",
          operation: nodeSource(node, ownerFile.source),
          guarded: false,
          start: node.start,
          end: node.end,
        });
      }
    },
    BinaryExpression(node) {
      if (!inScope(node) || (node.operator !== "/" && node.operator !== "%")) return;
      const root = rootIdentifier(node.right);
      if (!root || !parameters.has(root)) return;
      assumptions.push({
        parameter: root,
        kind: "division",
        operation: nodeSource(node, ownerFile.source),
        guarded: false,
        start: node.start,
        end: node.end,
      });
    },
    VariableDeclarator(node) {
      if (!inScope(node)) return;
      if (node.id.type !== "ObjectPattern" && node.id.type !== "ArrayPattern") return;
      if (!node.init) return;
      const root = rootIdentifier(node.init);
      if (!root || !parameters.has(root)) return;
      assumptions.push({
        parameter: root,
        kind: "destructuring",
        operation: nodeSource(node, ownerFile.source),
        guarded: false,
        start: node.start,
        end: node.end,
      });
    },
  }).visit(parsed.program);

  if (assumptions.length === 0) return undefined;

  const guards: string[] = [];
  const guardedParameters = new Set<string>();
  new Visitor({
    IfStatement(node) {
      if (!inScope(node)) return;
      for (const name of parameters) {
        if (mentionsName(node.test, parsed.program, name)) {
          guards.push(nodeSource(node, ownerFile.source));
          guardedParameters.add(name);
          break;
        }
      }
    },
    CallExpression(node) {
      if (!inScope(node)) return;
      const callee = nodeSource(node.callee, ownerFile.source);
      if (!/^(assert|invariant|ensure|check)([.(]|$)/.test(callee)) return;
      for (const name of parameters) {
        if (mentionsName(node, parsed.program, name)) {
          guards.push(nodeSource(node, ownerFile.source));
          guardedParameters.add(name);
          break;
        }
      }
    },
  }).visit(parsed.program);

  assumptions.sort((left, right) => left.start - right.start);
  for (const assumption of assumptions) {
    if (guardedParameters.has(assumption.parameter)) assumption.guarded = true;
  }

  const name = functionName(parsed.program, fn);
  return {
    function: {
      name: name ?? null,
      exported: name ? isFunctionExported(parsed.program, fn, name) : false,
      filePath: candidate.filePath,
      source: candidate.source,
      moduleSource: ownerFile.source.slice(0, 16_000),
      parameters: [...parameters],
    },
    assumptions: assumptions.map(({ parameter, kind, operation, guarded }) => ({
      parameter,
      kind,
      operation,
      guarded,
    })),
    guards,
    repository: {
      callers: name ? findFunctionCallers(candidate.filePath, name, projectFiles) : [],
    },
  };
}
