import { Visitor } from "oxc-parser";
import { parseCached } from "./parse-cache.js";
import type { Expression, Node, Statement } from "oxc-parser";
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
  findRelatedProjectModules,
  functionName,
  isFunctionExported,
} from "./repository.js";
import type { FunctionCaller, RelatedProjectModule } from "./repository.js";

export type LaunderedDefault = {
  source: string;
  kind: "nullish-default" | "or-default";
  defaulted: string;
  fallback: string;
  flowsToReturn: boolean;
};

export type LaunderedCatch = {
  source: string;
  caught: string | null;
  usesCaughtError: boolean;
  returned: string;
  returnsEmpty: boolean;
};

export type LaunderedAbsenceEvidence = {
  function: {
    name: string | null;
    exported: boolean;
    filePath: string;
    source: string;
  };
  defaults: LaunderedDefault[];
  catches: LaunderedCatch[];
  repository: {
    callers: FunctionCaller[];
    relatedModules: RelatedProjectModule[];
  };
};

function nodeSource(node: Node, source: string): string {
  return source.slice(node.start, node.end);
}

function isBoundaryValue(expression: Expression): boolean {
  return expression.type === "MemberExpression"
    || expression.type === "ChainExpression"
    || expression.type === "CallExpression"
    || expression.type === "AwaitExpression";
}

function collectReturnedNames(
  statements: Statement[],
  source: string,
  nested: NodeRange[],
  outer: NodeRange,
): Set<string> {
  const names = new Set<string>();
  const visit = (nodes: Statement[]): void => {
    for (const statement of nodes) {
      if (!containsNode(outer, statement) || !belongsDirectlyToFunction(statement, nested)) {
        continue;
      }
      if (statement.type === "ReturnStatement" && statement.argument) {
        const text = nodeSource(statement.argument, source);
        for (const match of text.matchAll(/\b([A-Za-z_$][\w$]*)\b/g)) {
          if (match[1]) names.add(match[1]);
        }
      }
      if (statement.type === "BlockStatement") visit(statement.body);
      if (statement.type === "IfStatement") {
        const branches = [statement.consequent, statement.alternate].filter(
          (branch): branch is Statement => branch !== null,
        );
        visit(branches);
      }
      if (statement.type === "TryStatement") {
        visit(statement.block.body);
        if (statement.handler) visit(statement.handler.body.body);
        if (statement.finalizer) visit(statement.finalizer.body);
      }
    }
  };
  visit(statements);
  return names;
}

const EMPTY_PATTERN = /^\s*(\[\]|\{\}|null|undefined|""|''|0|false)\s*;?\s*$/;

export function buildLaunderedAbsenceEvidence(
  candidate: Candidate,
  projectFiles: ProjectFile[],
): LaunderedAbsenceEvidence | undefined {
  if (candidate.kind !== "function") return undefined;
  const ownerFile = projectFiles.find((file) => file.filePath === candidate.filePath);
  if (!ownerFile) return undefined;
  const parsed = parseCached(ownerFile.filePath, ownerFile.source);
  if (parsed.errors.some((error) => error.severity === "Error")) return undefined;
  const fn = findDirectFunction(parsed.program, candidate);
  if (!fn || !fn.body) return undefined;

  const nested = nestedFunctionRanges(parsed.program, fn);
  const topStatements = fn.body.type === "BlockStatement" ? fn.body.body : [];
  const returnedNames = collectReturnedNames(topStatements, ownerFile.source, nested, fn);

  const directReturns = new Set<Node>();
  const declaratorTargets = new Map<Node, string>();
  new Visitor({
    ReturnStatement(statement) {
      if (containsNode(fn, statement) && belongsDirectlyToFunction(statement, nested)) {
        directReturns.add(statement);
      }
    },
    VariableDeclarator(declarator) {
      if (
        declarator.init
        && declarator.id.type === "Identifier"
        && containsNode(fn, declarator)
        && belongsDirectlyToFunction(declarator, nested)
      ) declaratorTargets.set(declarator.init, declarator.id.name);
    },
  }).visit(parsed.program);

  const flowsToReturn = (node: Node): boolean => {
    for (const statement of directReturns) {
      if (containsNode(statement, node)) return true;
    }
    for (const [init, name] of declaratorTargets) {
      if (containsNode(init, node) && returnedNames.has(name)) return true;
    }
    return false;
  };

  const defaults: LaunderedDefault[] = [];
  new Visitor({
    LogicalExpression(node) {
      if (!containsNode(fn, node) || !belongsDirectlyToFunction(node, nested)) return;
      if (node.operator !== "??" && node.operator !== "||") return;
      if (!isBoundaryValue(node.left)) return;
      defaults.push({
        source: nodeSource(node, ownerFile.source),
        kind: node.operator === "??" ? "nullish-default" : "or-default",
        defaulted: nodeSource(node.left, ownerFile.source),
        fallback: nodeSource(node.right, ownerFile.source),
        flowsToReturn: flowsToReturn(node),
      });
    },
  }).visit(parsed.program);

  const catches: LaunderedCatch[] = [];
  new Visitor({
    CatchClause(node) {
      if (!containsNode(fn, node) || !belongsDirectlyToFunction(node, nested)) return;
      const returns = node.body.body.filter(
        (statement): statement is Extract<Statement, { type: "ReturnStatement" }> =>
          statement.type === "ReturnStatement",
      );
      if (returns.length === 0) return;
      const caught = node.param ? nodeSource(node.param, ownerFile.source) : null;
      const caughtName = node.param?.type === "Identifier" ? node.param.name : null;
      const returnedSources = returns.map((item) =>
        item.argument ? nodeSource(item.argument, ownerFile.source) : "undefined"
      );
      const usesCaughtError = caughtName
        ? returnedSources.some((text) => new RegExp(`\\b${caughtName}\\b`).test(text))
        : false;
      for (const returned of returnedSources) {
        catches.push({
          source: nodeSource(node, ownerFile.source),
          caught,
          usesCaughtError,
          returned,
          returnsEmpty: EMPTY_PATTERN.test(returned),
        });
      }
    },
  }).visit(parsed.program);

  if (defaults.length === 0 && catches.length === 0) return undefined;

  const name = functionName(parsed.program, fn);
  return {
    function: {
      name: name ?? null,
      exported: name ? isFunctionExported(parsed.program, fn, name) : false,
      filePath: candidate.filePath,
      source: candidate.source,
    },
    defaults,
    catches,
    repository: {
      callers: name ? findFunctionCallers(candidate.filePath, name, projectFiles) : [],
      relatedModules: findRelatedProjectModules(candidate.filePath, parsed.program, projectFiles),
    },
  };
}
