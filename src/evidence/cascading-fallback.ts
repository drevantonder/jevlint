import { parseSync, Visitor } from "oxc-parser";
import type { CallExpression, CatchClause, Node, Program, TryStatement } from "oxc-parser";
import type { Candidate, ProjectFile } from "../types.js";
import {
  belongsDirectlyToFunction,
  containsNode,
  nestedFunctionRanges,
} from "./function-scope.js";
import type { NodeRange } from "./function-scope.js";
import {
  calleeRootName,
  findDirectFunction,
  findFunctionCallers,
  findRelatedProjectModules,
  functionName,
  isFunctionExported,
  moduleImports,
} from "./repository.js";
import type {
  FunctionCaller,
  FunctionNode,
  RelatedProjectModule,
} from "./repository.js";

export type FallbackCall = {
  call: string;
  root: string | null;
  importedFrom: string | null;
};

export type CascadingFallbackHandler = {
  primaryCalls: FallbackCall[];
  fallbackCalls: FallbackCall[];
  sharedDependencies: {
    root: string | null;
    importedFrom: string | null;
    primaryCall: string;
    fallbackCall: string;
  }[];
  fallbackReturnsStatic: boolean;
};

export type CascadingFallbackEvidence = {
  function: {
    name: string | null;
    exported: boolean;
    filePath: string;
    source: string;
    moduleSource: string;
  };
  handlers: CascadingFallbackHandler[];
  repository: {
    callers: FunctionCaller[];
    relatedModules: RelatedProjectModule[];
  };
};

function nodeSource(node: Node, source: string): string {
  return source.slice(node.start, node.end);
}

function importSourceFor(
  root: string | null,
  imports: { source: string; local: string }[],
): string | null {
  if (!root) return null;
  return imports.find(({ local }) => local === root)?.source ?? null;
}

function callsWithin(
  range: NodeRange,
  program: Program,
  source: string,
  nested: NodeRange[],
  imports: { source: string; local: string }[],
): FallbackCall[] {
  const calls: FallbackCall[] = [];
  new Visitor({
    CallExpression(node: CallExpression) {
      if (!containsNode(range, node) || !belongsDirectlyToFunction(node, nested)) return;
      const root = calleeRootName(node.callee);
      calls.push({
        call: nodeSource(node, source),
        root,
        importedFrom: importSourceFor(root, imports),
      });
    },
  }).visit(program);
  return calls;
}

function fallbackReturnsStatic(
  handler: CatchClause,
  program: Program,
  source: string,
  nested: NodeRange[],
): boolean {
  let found = false;
  new Visitor({
    ReturnStatement(node) {
      if (!containsNode(handler.body, node) || !belongsDirectlyToFunction(node, nested)) return;
      const argument = node.argument;
      if (!argument) return;
      if (argument.type === "Literal" || argument.type === "TemplateLiteral") {
        found = true;
        return;
      }
      if (/cache|static|fallback|default/i.test(source.slice(argument.start, argument.end))) {
        found = true;
      }
    },
  }).visit(program);
  return found;
}

function handlerEvidence(
  statement: TryStatement,
  handler: CatchClause,
  source: string,
  program: Program,
  nested: NodeRange[],
  imports: { source: string; local: string }[],
): CascadingFallbackHandler {
  const primaryCalls = callsWithin(statement.block, program, source, nested, imports);
  const fallbackCalls = callsWithin(handler.body, program, source, nested, imports);
  const sharedDependencies: CascadingFallbackHandler["sharedDependencies"] = [];
  for (const fallback of fallbackCalls) {
    const primary = primaryCalls.find((candidate) =>
      candidate.root !== null
      && candidate.root === fallback.root
      && candidate.importedFrom === fallback.importedFrom
    );
    if (primary && fallback.root !== null) {
      sharedDependencies.push({
        root: fallback.root,
        importedFrom: fallback.importedFrom,
        primaryCall: primary.call,
        fallbackCall: fallback.call,
      });
    }
  }
  return {
    primaryCalls,
    fallbackCalls,
    sharedDependencies,
    fallbackReturnsStatic: fallbackReturnsStatic(handler, program, source, nested),
  };
}

export function buildCascadingFallbackEvidence(
  candidate: Candidate,
  projectFiles: ProjectFile[],
): CascadingFallbackEvidence | undefined {
  if (candidate.kind !== "function") return undefined;
  const ownerFile = projectFiles.find((file) => file.filePath === candidate.filePath);
  if (!ownerFile) return undefined;
  const parsed = parseSync(ownerFile.filePath, ownerFile.source, { range: true });
  if (parsed.errors.some((error) => error.severity === "Error")) return undefined;
  const fn: FunctionNode | undefined = findDirectFunction(parsed.program, candidate);
  if (!fn) return undefined;

  const nested = nestedFunctionRanges(parsed.program, fn);
  const imports = moduleImports(parsed.program);
  const handlers: CascadingFallbackHandler[] = [];
  new Visitor({
    TryStatement(statement: TryStatement) {
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
          parsed.program,
          nested,
          imports,
        ));
      }
    },
  }).visit(parsed.program);
  const withFallbackCalls = handlers.filter(({ fallbackCalls }) => fallbackCalls.length > 0);
  if (withFallbackCalls.length === 0) return undefined;

  const name = functionName(parsed.program, fn);
  return {
    function: {
      name: name ?? null,
      exported: name ? isFunctionExported(parsed.program, fn, name) : false,
      filePath: candidate.filePath,
      source: candidate.source,
      moduleSource: ownerFile.source.slice(0, 16_000),
    },
    handlers: withFallbackCalls,
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
