import { Visitor } from "oxc-parser";
import { parseCached } from "./parse-cache.js";
import type { Expression, Node } from "oxc-parser";
import type { Candidate, ProjectFile } from "../types.js";
import {
  belongsDirectlyToFunction,
  containsNode,
  nestedFunctionRanges,
} from "./function-scope.js";
import {
  findDirectFunction,
  findFunctionCallers,
  findRelatedProjectModules,
  functionName,
  isFunctionExported,
} from "./repository.js";
import type { FunctionCaller, RelatedProjectModule } from "./repository.js";

export type PresenceCheck = {
  source: string;
  kind: "if" | "and" | "or-default" | "ternary";
  tested: string;
  usesNullish: boolean;
};

export type FalsyAbsentConflationEvidence = {
  function: {
    name: string | null;
    exported: boolean;
    filePath: string;
    source: string;
    declaredTypes: string[];
  };
  checks: PresenceCheck[];
  repository: {
    callers: FunctionCaller[];
    relatedModules: RelatedProjectModule[];
  };
};

function nodeSource(node: Node, source: string): string {
  return source.slice(node.start, node.end);
}

function isTestable(expression: Expression): boolean {
  return expression.type === "Identifier"
    || expression.type === "MemberExpression"
    || expression.type === "ChainExpression"
    || expression.type === "CallExpression";
}

function isExplicitComparison(expression: Expression): boolean {
  return expression.type === "BinaryExpression"
    || (expression.type === "UnaryExpression" && expression.operator === "typeof");
}

export function buildFalsyAbsentConflationEvidence(
  candidate: Candidate,
  projectFiles: ProjectFile[],
): FalsyAbsentConflationEvidence | undefined {
  if (candidate.kind !== "function") return undefined;
  const ownerFile = projectFiles.find((file) => file.filePath === candidate.filePath);
  if (!ownerFile) return undefined;
  const parsed = parseCached(ownerFile.filePath, ownerFile.source);
  if (parsed.errors.some((error) => error.severity === "Error")) return undefined;
  const fn = findDirectFunction(parsed.program, candidate);
  if (!fn) return undefined;

  const nested = nestedFunctionRanges(parsed.program, fn);
  const checks: PresenceCheck[] = [];
  const push = (
    node: Node,
    kind: PresenceCheck["kind"],
    tested: Expression,
    scope: Node,
  ): void => {
    const text = nodeSource(scope, ownerFile.source);
    checks.push({
      source: nodeSource(node, ownerFile.source),
      kind,
      tested: nodeSource(tested, ownerFile.source),
      usesNullish: text.includes("??"),
    });
  };

  new Visitor({
    IfStatement(node) {
      if (!containsNode(fn, node) || !belongsDirectlyToFunction(node, nested)) return;
      if (!isTestable(node.test) || isExplicitComparison(node.test)) return;
      push(node, "if", node.test, node);
    },
    LogicalExpression(node) {
      if (!containsNode(fn, node) || !belongsDirectlyToFunction(node, nested)) return;
      if (node.operator === "&&") {
        if (!isTestable(node.left) || isExplicitComparison(node.left)) return;
        push(node, "and", node.left, node);
      } else if (node.operator === "||") {
        if (!isTestable(node.left) || isExplicitComparison(node.left)) return;
        push(node, "or-default", node.left, node);
      }
    },
    ConditionalExpression(node) {
      if (!containsNode(fn, node) || !belongsDirectlyToFunction(node, nested)) return;
      if (!isTestable(node.test) || isExplicitComparison(node.test)) return;
      push(node, "ternary", node.test, node);
    },
  }).visit(parsed.program);

  if (checks.length === 0) return undefined;

  const declaredTypes = fn.params.map((parameter) =>
    nodeSource(parameter, ownerFile.source)
  );
  const name = functionName(parsed.program, fn);
  return {
    function: {
      name: name ?? null,
      exported: name ? isFunctionExported(parsed.program, fn, name) : false,
      filePath: candidate.filePath,
      source: candidate.source,
      declaredTypes,
    },
    checks,
    repository: {
      callers: name ? findFunctionCallers(candidate.filePath, name, projectFiles) : [],
      relatedModules: findRelatedProjectModules(candidate.filePath, parsed.program, projectFiles),
    },
  };
}
