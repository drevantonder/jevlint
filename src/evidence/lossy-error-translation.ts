import { Visitor } from "oxc-parser";
import { parseCached } from "./parse-cache.js";
import type {
  CatchClause,
  Node,
  Program,
  ThrowStatement,
  TryStatement,
} from "oxc-parser";
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
  RelatedProjectModule,
} from "./repository.js";

type TranslationEvidence = {
  caught: string | null;
  tryBlock: string;
  catchBody: string;
  throw: string;
  thrownType: string | null;
  kind: "rethrow" | "new-error" | "other";
  referencesCaughtError: boolean;
  preservesCaughtErrorAsCause: boolean;
};

type ModuleContext = {
  filePath: string;
  source: string;
};

export type LossyErrorTranslationEvidence = {
  function: {
    name: string | null;
    exported: boolean;
    filePath: string;
    source: string;
    moduleSource: string;
  };
  translations: TranslationEvidence[];
  repository: {
    callers: FunctionCaller[];
    callerModules: ModuleContext[];
    relatedModules: RelatedProjectModule[];
  };
};

function nodeSource(node: Node, source: string): string {
  return source.slice(node.start, node.end);
}

function caughtIdentifier(handler: CatchClause): string | null {
  return handler.param?.type === "Identifier" ? handler.param.name : null;
}

function referencesIdentifier(
  program: Program,
  range: NodeRange,
  identifier: string | null,
): boolean {
  if (!identifier) return false;
  let referenced = false;
  new Visitor({
    Identifier(node) {
      if (node.name === identifier && containsNode(range, node)) referenced = true;
    },
  }).visit(program);
  return referenced;
}

function preservesAsCause(
  statement: ThrowStatement,
  caught: string | null,
  program: Program,
  source: string,
): boolean {
  if (!caught) return false;
  let preserves = false;
  new Visitor({
    Property(node) {
      if (!containsNode(statement.argument, node)) return;
      const key = source.slice(node.key.start, node.key.end).replaceAll(/["']/g, "");
      if (key !== "cause") return;
      if (referencesIdentifier(program, node.value, caught)) preserves = true;
    },
  }).visit(program);
  return preserves;
}

function thrownType(statement: ThrowStatement, source: string): string | null {
  const argument = statement.argument;
  if (argument.type !== "NewExpression" && argument.type !== "CallExpression") return null;
  return nodeSource(argument.callee, source);
}

function translationKind(
  statement: ThrowStatement,
  caught: string | null,
): TranslationEvidence["kind"] {
  if (
    caught
    && statement.argument.type === "Identifier"
    && statement.argument.name === caught
  ) return "rethrow";
  return statement.argument.type === "NewExpression" ? "new-error" : "other";
}

function translationsFor(
  statement: TryStatement,
  handler: CatchClause,
  program: Program,
  source: string,
  nested: NodeRange[],
): TranslationEvidence[] {
  const result: TranslationEvidence[] = [];
  const caught = caughtIdentifier(handler);
  new Visitor({
    ThrowStatement(thrown) {
      if (
        !containsNode(handler.body, thrown)
        || !belongsDirectlyToFunction(thrown, nested)
      ) return;
      result.push({
        caught,
        tryBlock: nodeSource(statement.block, source),
        catchBody: nodeSource(handler.body, source),
        throw: nodeSource(thrown, source),
        thrownType: thrownType(thrown, source),
        kind: translationKind(thrown, caught),
        referencesCaughtError: referencesIdentifier(program, thrown.argument, caught),
        preservesCaughtErrorAsCause: preservesAsCause(thrown, caught, program, source),
      });
    },
  }).visit(program);
  return result;
}

function callerModules(
  callers: FunctionCaller[],
  projectFiles: ProjectFile[],
): ModuleContext[] {
  const paths = new Set(callers.map(({ filePath }) => filePath));
  return projectFiles
    .filter(({ filePath }) => paths.has(filePath))
    .slice(0, 12)
    .map(({ filePath, source }) => ({ filePath, source: source.slice(0, 12_000) }));
}

export function buildLossyErrorTranslationEvidence(
  candidate: Candidate,
  projectFiles: ProjectFile[],
): LossyErrorTranslationEvidence | undefined {
  if (candidate.kind !== "function") return undefined;
  const ownerFile = projectFiles.find((file) => file.filePath === candidate.filePath);
  if (!ownerFile) return undefined;
  const parsed = parseCached(ownerFile.filePath, ownerFile.source);
  if (parsed.errors.some((error) => error.severity === "Error")) return undefined;
  const fn = findDirectFunction(parsed.program, candidate);
  if (!fn) return undefined;

  const nested = nestedFunctionRanges(parsed.program, fn);
  const translations: TranslationEvidence[] = [];
  new Visitor({
    TryStatement(statement) {
      if (
        !statement.handler
        || !containsNode(fn, statement)
        || !belongsDirectlyToFunction(statement, nested)
      ) return;
      translations.push(...translationsFor(
        statement,
        statement.handler,
        parsed.program,
        ownerFile.source,
        nested,
      ));
    },
  }).visit(parsed.program);
  if (translations.length === 0) return undefined;

  const name = functionName(parsed.program, fn);
  const callers = name ? findFunctionCallers(candidate.filePath, name, projectFiles) : [];
  return {
    function: {
      name: name ?? null,
      exported: name ? isFunctionExported(parsed.program, fn, name) : false,
      filePath: candidate.filePath,
      source: candidate.source,
      moduleSource: ownerFile.source.slice(0, 16_000),
    },
    translations,
    repository: {
      callers,
      callerModules: callerModules(callers, projectFiles),
      relatedModules: findRelatedProjectModules(
        candidate.filePath,
        parsed.program,
        projectFiles,
      ),
    },
  };
}
