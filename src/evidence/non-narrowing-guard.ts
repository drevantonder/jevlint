import { parseSync, Visitor } from "oxc-parser";
import type { Expression, Node, Program, Statement } from "oxc-parser";
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

export type SettlingStatement = {
  source: string;
  start: number;
  kind: "guard-return" | "guard-throw" | "default-assignment" | "explicit-check";
  settled: string;
};

export type RedundantGuard = {
  source: string;
  kind: "if" | "optional-chain" | "nullish-default";
  tested: string;
  settledBy: SettlingStatement[];
  reassignedBetween: boolean;
};

export type NonNarrowingGuardEvidence = {
  function: {
    name: string | null;
    exported: boolean;
    filePath: string;
    source: string;
  };
  guards: RedundantGuard[];
  nearbyEscapeHatch: boolean;
  repository: {
    callers: FunctionCaller[];
  };
};

function nodeSource(node: Node, source: string): string {
  return source.slice(node.start, node.end);
}

function testRootName(test: Expression): string | undefined {
  if (test.type === "Identifier") return test.name;
  if (test.type === "MemberExpression") return testRootName(test.object);
  if (test.type === "ChainExpression") return testRootName(test.expression);
  if (test.type === "UnaryExpression" && test.operator === "!") return testRootName(test.argument);
  if (
    test.type === "BinaryExpression"
    && (test.operator === "==" || test.operator === "===" || test.operator === "!="
      || test.operator === "!==")
  ) {
    if (test.left.type === "Identifier") return test.left.name;
    if (test.right.type === "Identifier") return test.right.name;
    const left = test.left.type === "MemberExpression" ? testRootName(test.left) : undefined;
    return left ?? (test.right.type === "MemberExpression" ? testRootName(test.right) : undefined);
  }
  return undefined;
}

function chainRootName(chain: Expression): string | undefined {
  if (chain.type === "Identifier") return chain.name;
  if (chain.type === "MemberExpression") return testRootName(chain.object);
  if (chain.type === "CallExpression") {
    return chain.callee.type === "MemberExpression"
      ? testRootName(chain.callee.object)
      : undefined;
  }
  return undefined;
}

type CollectedGuard =
  | { node: Node; kind: "if"; tested: string }
  | { node: Node; kind: "optional-chain" | "nullish-default"; tested: string };

function collectSettling(
  statements: Statement[],
  source: string,
  nested: NodeRange[],
  outer: NodeRange,
): SettlingStatement[] {
  const result: SettlingStatement[] = [];
  const visit = (nodes: Statement[]): void => {
    for (const statement of nodes) {
      if (!containsNode(outer, statement) || !belongsDirectlyToFunction(statement, nested)) {
        continue;
      }
      if (statement.type === "IfStatement") {
        const root = testRootName(statement.test);
        const consequent = statement.consequent.type === "BlockStatement"
          ? statement.consequent.body
          : [statement.consequent];
        const exits = consequent.length === 1
          && (consequent[0]?.type === "ReturnStatement" || consequent[0]?.type === "ThrowStatement");
        if (root && exits) {
          result.push({
            source: nodeSource(statement, source),
            start: statement.start,
            kind: consequent[0]?.type === "ThrowStatement" ? "guard-throw" : "guard-return",
            settled: root,
          });
        }
      }
      if (
        statement.type === "VariableDeclaration"
        && statement.declarations.length === 1
        && statement.declarations[0]?.init?.type === "LogicalExpression"
        && statement.declarations[0].init.operator === "??"
        && statement.declarations[0].id.type === "Identifier"
      ) {
        result.push({
          source: nodeSource(statement, source),
          start: statement.start,
          kind: "default-assignment",
          settled: statement.declarations[0].id.name,
        });
      }
      if (statement.type === "BlockStatement") visit(statement.body);
      if (statement.type === "TryStatement") {
        visit(statement.block.body);
        if (statement.handler) visit(statement.handler.body.body);
      }
    }
  };
  visit(statements);
  return result;
}

function assignedNamesBetween(
  program: Program,
  fn: FunctionNode,
  source: string,
  nested: NodeRange[],
  settled: SettlingStatement[],
  guard: Node,
): Set<string> {
  const assigned = new Set<string>();
  const earliestSettling = Math.min(...settled.map(({ start }) => start));
  new Visitor({
    AssignmentExpression(node) {
      if (!containsNode(fn, node) || !belongsDirectlyToFunction(node, nested)) return;
      if (node.start > earliestSettling && node.end < guard.start) {
        if (node.left.type === "Identifier") assigned.add(node.left.name);
      }
    },
  }).visit(program);
  return assigned;
}

export function buildNonNarrowingGuardEvidence(
  candidate: Candidate,
  projectFiles: ProjectFile[],
): NonNarrowingGuardEvidence | undefined {
  if (candidate.kind !== "function") return undefined;
  const ownerFile = projectFiles.find((file) => file.filePath === candidate.filePath);
  if (!ownerFile) return undefined;
  const parsed = parseSync(ownerFile.filePath, ownerFile.source, { range: true });
  if (parsed.errors.some((error) => error.severity === "Error")) return undefined;
  const fn = findDirectFunction(parsed.program, candidate);
  if (!fn || !fn.body) return undefined;

  const nested = nestedFunctionRanges(parsed.program, fn);
  const topStatements = fn.body.type === "BlockStatement" ? fn.body.body : [];
  const settling = collectSettling(topStatements, ownerFile.source, nested, fn);
  if (settling.length === 0) return undefined;

  const collected: CollectedGuard[] = [];
  new Visitor({
    IfStatement(node) {
      if (!containsNode(fn, node) || !belongsDirectlyToFunction(node, nested)) return;
      const tested = testRootName(node.test);
      if (tested) collected.push({ node, kind: "if", tested });
    },
    ChainExpression(node) {
      if (!containsNode(fn, node) || !belongsDirectlyToFunction(node, nested)) return;
      const tested = chainRootName(node.expression);
      if (tested) collected.push({ node, kind: "optional-chain", tested });
    },
    LogicalExpression(node) {
      if (!containsNode(fn, node) || !belongsDirectlyToFunction(node, nested)) return;
      if (node.operator !== "??") return;
      const tested = node.left.type === "Identifier"
        ? node.left.name
        : node.left.type === "MemberExpression"
          ? testRootName(node.left)
          : undefined;
      if (tested) collected.push({ node, kind: "nullish-default", tested });
    },
  }).visit(parsed.program);

  const guards: RedundantGuard[] = [];
  for (const guard of collected) {
    const earlier = settling.filter(
      ({ settled, start }) => settled === guard.tested && start < guard.node.start,
    );
    if (earlier.length === 0) continue;
    const reassigned = assignedNamesBetween(parsed.program, fn, ownerFile.source, nested, earlier, guard.node);
    guards.push({
      source: nodeSource(guard.node, ownerFile.source),
      kind: guard.kind,
      tested: guard.tested,
      settledBy: earlier,
      reassignedBetween: reassigned.has(guard.tested),
    });
  }

  if (guards.length === 0) return undefined;

  const nearbyEscapeHatch = candidate.source.includes(" as ")
    || candidate.source.includes(": any")
    || candidate.source.includes("!.");

  const name = functionName(parsed.program, fn);
  return {
    function: {
      name: name ?? null,
      exported: name ? isFunctionExported(parsed.program, fn, name) : false,
      filePath: candidate.filePath,
      source: candidate.source,
    },
    guards,
    nearbyEscapeHatch,
    repository: {
      callers: name ? findFunctionCallers(candidate.filePath, name, projectFiles) : [],
    },
  };
}
