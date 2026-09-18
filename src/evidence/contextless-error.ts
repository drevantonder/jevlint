import { Visitor } from "oxc-parser";
import { parseCached } from "./parse-cache.js";
import type { CatchClause, Expression, Node, Program, ThrowStatement } from "oxc-parser";
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

type ThrownErrorEvidence = {
  operation: string;
  thrownType: string | null;
  kind: "no-argument" | "static-literal" | "bare-rethrow" | "context-carrying" | "other";
  hasMessageArgument: boolean;
  hasInterpolation: boolean;
  hasCause: boolean;
  hasStructuredFields: boolean;
  referencesCaughtError: boolean;
};

type EmptyRejectionEvidence = {
  operation: string;
};

export type ContextlessErrorEvidence = {
  function: {
    name: string | null;
    exported: boolean;
    filePath: string;
    source: string;
    moduleSource: string;
  };
  thrownErrors: ThrownErrorEvidence[];
  emptyRejections: EmptyRejectionEvidence[];
  repository: {
    callers: FunctionCaller[];
  };
};

function nodeSource(node: Node, source: string): string {
  return source.slice(node.start, node.end);
}

function isStringRaw(raw: string | null): boolean {
  if (raw === null || raw === "") return false;
  const first = raw[0];
  return first === "\"" || first === "'";
}

function caughtName(handler: CatchClause): string | null {
  return handler.param?.type === "Identifier" ? handler.param.name : null;
}

function enclosingCaughtNames(
  statement: ThrowStatement,
  handlers: { handler: CatchClause; body: NodeRange }[],
): string[] {
  return handlers
    .filter(({ body }) => containsNode(body, statement))
    .map(({ handler }) => caughtName(handler))
    .filter((name): name is string => name !== null);
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

function hasInterpolationValue(argument: Expression, program: Program): boolean {
  let interpolated = false;
  new Visitor({
    TemplateLiteral(node) {
      if (containsNode(argument, node) && node.expressions.length > 0) interpolated = true;
    },
    BinaryExpression(node) {
      if (!containsNode(argument, node) || node.operator !== "+") return;
      let mentionsIdentifier = false;
      new Visitor({
        Identifier(child) {
          if (containsNode(node, child)) mentionsIdentifier = true;
        },
      }).visit(program);
      if (mentionsIdentifier) interpolated = true;
    },
  }).visit(program);
  return interpolated;
}

function hasCauseField(argument: Expression, program: Program, source: string): boolean {
  let cause = false;
  new Visitor({
    Property(node) {
      if (!containsNode(argument, node)) return;
      const key = source.slice(node.key.start, node.key.end).replaceAll(/["']/g, "");
      if (key === "cause") cause = true;
    },
  }).visit(program);
  return cause;
}

function hasStructuredFields(argument: Expression, program: Program): boolean {
  if (argument.type !== "ObjectExpression") return false;
  let fields = 0;
  new Visitor({
    Property(node) {
      if (containsNode(argument, node)) fields += 1;
    },
  }).visit(program);
  return fields > 0;
}

function thrownTypeName(statement: ThrowStatement, source: string): string | null {
  const argument = statement.argument;
  if (argument.type !== "NewExpression" && argument.type !== "CallExpression") return null;
  return nodeSource(argument.callee, source);
}

function thrownEvidence(
  statement: ThrowStatement,
  handlers: { handler: CatchClause; body: NodeRange }[],
  program: Program,
  source: string,
): ThrownErrorEvidence {
  const argument = statement.argument;
  const caughtNames = enclosingCaughtNames(statement, handlers);
  const isBareRethrow = argument.type === "Identifier" && caughtNames.includes(argument.name);
  const referencesCaughtError = caughtNames.some((name) => referencesIdentifier(program, argument, name));
  const thrownType = thrownTypeName(statement, source);

  if (isBareRethrow) {
    return {
      operation: nodeSource(statement, source),
      thrownType: null,
      kind: "bare-rethrow",
      hasMessageArgument: false,
      hasInterpolation: false,
      hasCause: false,
      hasStructuredFields: false,
      referencesCaughtError: true,
    };
  }

  if (argument.type === "NewExpression" || argument.type === "CallExpression") {
    const args: Expression[] = [];
    for (const item of argument.arguments) {
      if (item.type !== "SpreadElement") args.push(item);
    }
    if (args.length === 0) {
      return {
        operation: nodeSource(statement, source),
        thrownType,
        kind: "no-argument",
        hasMessageArgument: false,
        hasInterpolation: false,
        hasCause: false,
        hasStructuredFields: false,
        referencesCaughtError,
      };
    }
    const first = args[0];
    const isStaticLiteral = first !== undefined
      && first.type === "Literal"
      && isStringRaw(first.raw)
      && !hasInterpolationValue(argument, program);
    const cause = args.some((item) => hasCauseField(item, program, source));
    const structured = args.some((item) => hasStructuredFields(item, program));
    const interpolation = hasInterpolationValue(argument, program);
    const contextCarrying = cause || structured || interpolation
      || args.some((item) => item.type === "Identifier");
    return {
      operation: nodeSource(statement, source),
      thrownType,
      kind: contextCarrying ? "context-carrying" : isStaticLiteral ? "static-literal" : "other",
      hasMessageArgument: true,
      hasInterpolation: interpolation,
      hasCause: cause,
      hasStructuredFields: structured,
      referencesCaughtError,
    };
  }

  if (argument.type === "ObjectExpression") {
    const structured = hasStructuredFields(argument, program);
    const cause = hasCauseField(argument, program, source);
    return {
      operation: nodeSource(statement, source),
      thrownType: null,
      kind: cause || structured ? "context-carrying" : "other",
      hasMessageArgument: false,
      hasInterpolation: hasInterpolationValue(argument, program),
      hasCause: cause,
      hasStructuredFields: structured,
      referencesCaughtError,
    };
  }

  return {
    operation: nodeSource(statement, source),
    thrownType,
    kind: argument.type === "Identifier" ? "context-carrying" : "other",
    hasMessageArgument: false,
    hasInterpolation: false,
    hasCause: false,
    hasStructuredFields: false,
    referencesCaughtError,
  };
}

export function buildContextlessErrorEvidence(
  candidate: Candidate,
  projectFiles: ProjectFile[],
): ContextlessErrorEvidence | undefined {
  if (candidate.kind !== "function") return undefined;
  const ownerFile = projectFiles.find((file) => file.filePath === candidate.filePath);
  if (!ownerFile) return undefined;
  const parsed = parseCached(ownerFile.filePath, ownerFile.source);
  if (parsed.errors.some((error) => error.severity === "Error")) return undefined;
  const fn: FunctionNode | undefined = findDirectFunction(parsed.program, candidate);
  if (!fn) return undefined;

  const nested = nestedFunctionRanges(parsed.program, fn);
  const handlers: { handler: CatchClause; body: NodeRange }[] = [];
  new Visitor({
    CatchClause(handler) {
      if (
        handler.start >= fn.start
        && handler.end <= fn.end
        && belongsDirectlyToFunction(handler, nested)
      ) handlers.push({ handler, body: handler.body });
    },
  }).visit(parsed.program);

  const thrownErrors: ThrownErrorEvidence[] = [];
  const emptyRejections: EmptyRejectionEvidence[] = [];
  new Visitor({
    ThrowStatement(statement) {
      if (
        statement.start < fn.start
        || statement.end > fn.end
        || !belongsDirectlyToFunction(statement, nested)
      ) return;
      thrownErrors.push(thrownEvidence(statement, handlers, parsed.program, ownerFile.source));
    },
    CallExpression(node) {
      if (
        node.start < fn.start
        || node.end > fn.end
        || !belongsDirectlyToFunction(node, nested)
      ) return;
      if (
        node.callee.type === "MemberExpression"
        && !node.callee.computed
        && node.callee.object.type === "Identifier"
        && node.callee.object.name === "Promise"
        && node.callee.property.type === "Identifier"
        && node.callee.property.name === "reject"
        && node.arguments.length === 0
      ) {
        emptyRejections.push({ operation: nodeSource(node, ownerFile.source) });
      }
    },
  }).visit(parsed.program);

  if (thrownErrors.length === 0 && emptyRejections.length === 0) return undefined;

  const name = functionName(parsed.program, fn);
  return {
    function: {
      name: name ?? null,
      exported: name ? isFunctionExported(parsed.program, fn, name) : false,
      filePath: candidate.filePath,
      source: candidate.source,
      moduleSource: ownerFile.source.slice(0, 16_000),
    },
    thrownErrors,
    emptyRejections,
    repository: {
      callers: name ? findFunctionCallers(candidate.filePath, name, projectFiles) : [],
    },
  };
}
