import { Visitor } from "oxc-parser";
import { parseCached } from "./parse-cache.js";
import type { CatchClause, Node, Program, TryStatement } from "oxc-parser";
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
import type {
  FunctionCaller,
  FunctionNode,
  RelatedProjectModule,
} from "./repository.js";

type ErrorHandlerEvidence = {
  caught: string | null;
  usesCaughtError: boolean;
  tryBlock: string;
  catchBody: string;
  finallyBlock: string | null;
  throws: string[];
  returns: string[];
  calls: string[];
  controlTransfers: string[];
  continuationAfterTry: string;
};

export type SwallowedErrorEvidence = {
  function: {
    name: string | null;
    exported: boolean;
    filePath: string;
    source: string;
    moduleSource: string;
  };
  handlers: ErrorHandlerEvidence[];
  repository: {
    callers: FunctionCaller[];
    relatedModules: RelatedProjectModule[];
  };
};

function caughtName(handler: CatchClause, source: string): string | null {
  return handler.param ? source.slice(handler.param.start, handler.param.end) : null;
}

function usesCaughtIdentifier(
  handler: CatchClause,
  program: Program,
  nested: NodeRange[],
): boolean {
  if (!handler.param || handler.param.type !== "Identifier") return false;
  const name = handler.param.name;
  let used = false;
  new Visitor({
    Identifier(node) {
      if (
        node.name === name
        && containsNode(handler.body, node)
        && belongsDirectlyToFunction(node, nested)
      ) used = true;
    },
  }).visit(program);
  return used;
}

function nodeSource(node: Node, source: string): string {
  return source.slice(node.start, node.end);
}

function handlerEvidence(
  statement: TryStatement,
  handler: CatchClause,
  source: string,
  owner: FunctionNode,
  program: Program,
  nested: NodeRange[],
): ErrorHandlerEvidence {
  const throws: string[] = [];
  const returns: string[] = [];
  const calls: string[] = [];
  const controlTransfers: string[] = [];
  new Visitor({
    ThrowStatement(node) {
      if (containsNode(handler.body, node) && belongsDirectlyToFunction(node, nested)) {
        throws.push(nodeSource(node, source));
      }
    },
    ReturnStatement(node) {
      if (containsNode(handler.body, node) && belongsDirectlyToFunction(node, nested)) {
        returns.push(nodeSource(node, source));
      }
    },
    CallExpression(node) {
      if (containsNode(handler.body, node) && belongsDirectlyToFunction(node, nested)) {
        calls.push(nodeSource(node, source));
      }
    },
    BreakStatement(node) {
      if (containsNode(handler.body, node) && belongsDirectlyToFunction(node, nested)) {
        controlTransfers.push(nodeSource(node, source));
      }
    },
    ContinueStatement(node) {
      if (containsNode(handler.body, node) && belongsDirectlyToFunction(node, nested)) {
        controlTransfers.push(nodeSource(node, source));
      }
    },
  }).visit(program);

  return {
    caught: caughtName(handler, source),
    usesCaughtError: usesCaughtIdentifier(handler, program, nested),
    tryBlock: nodeSource(statement.block, source),
    catchBody: nodeSource(handler.body, source),
    finallyBlock: statement.finalizer ? nodeSource(statement.finalizer, source) : null,
    throws,
    returns,
    calls,
    controlTransfers,
    continuationAfterTry: source.slice(statement.end, owner.end),
  };
}

export function buildSwallowedErrorEvidence(
  candidate: Candidate,
  projectFiles: ProjectFile[],
): SwallowedErrorEvidence | undefined {
  if (candidate.kind !== "function") return undefined;
  const ownerFile = projectFiles.find((file) => file.filePath === candidate.filePath);
  if (!ownerFile) return undefined;
  const parsed = parseCached(ownerFile.filePath, ownerFile.source);
  if (parsed.errors.some((error) => error.severity === "Error")) return undefined;
  const fn = findDirectFunction(parsed.program, candidate);
  if (!fn) return undefined;

  const nested = nestedFunctionRanges(parsed.program, fn);
  const handlers: ErrorHandlerEvidence[] = [];
  new Visitor({
    TryStatement(statement) {
      if (
        statement.handler
        && statement.start >= fn.start
        && statement.end <= fn.end
        && belongsDirectlyToFunction(statement, nested)
      ) {
        handlers.push(handlerEvidence(
          statement,
          statement.handler,
          ownerFile.source,
          fn,
          parsed.program,
          nested,
        ));
      }
    },
  }).visit(parsed.program);
  if (handlers.length === 0) return undefined;

  const name = functionName(parsed.program, fn);
  return {
    function: {
      name: name ?? null,
      exported: name ? isFunctionExported(parsed.program, fn, name) : false,
      filePath: candidate.filePath,
      source: candidate.source,
      moduleSource: ownerFile.source.slice(0, 16_000),
    },
    handlers,
    repository: {
      callers: name ? findFunctionCallers(candidate.filePath, name, projectFiles) : [],
      relatedModules: findRelatedProjectModules(
        candidate.filePath,
        parsed.program,
        projectFiles,
      ),
    },
  };
}
