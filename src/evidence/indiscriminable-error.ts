import { Visitor } from "oxc-parser";
import { parseCached } from "./parse-cache.js";
import type {
  CallExpression,
  CatchClause,
  Expression,
  Node,
  Program,
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
  functionName,
  isFunctionExported,
} from "./repository.js";
import type { FunctionCaller, FunctionNode } from "./repository.js";

export type IndiscriminableThrownError = {
  operation: string;
  thrownType: string | null;
  kind: "bare-rethrow" | "discriminated" | "indiscriminable" | "other";
  isBareError: boolean;
  hasCode: boolean;
  hasCause: boolean;
  hasStatus: boolean;
  isGenericMessage: boolean;
  referencesCaughtError: boolean;
};

export type DiscriminatingHandler = {
  filePath: string;
  operation: string;
  checks: string[];
};

export type IndiscriminableErrorEvidence = {
  function: {
    name: string | null;
    exported: boolean;
    filePath: string;
    source: string;
    moduleSource: string;
  };
  thrownErrors: IndiscriminableThrownError[];
  rejections: IndiscriminableThrownError[];
  repository: {
    callers: FunctionCaller[];
    discriminatingHandlers: DiscriminatingHandler[];
  };
};

const GENERIC_MESSAGE_PATTERNS = [
  /something went wrong/i,
  /^(an?\s+)?(unknown|unexpected)\s+error\b/i,
  /^oops\b/i,
  /^(error|failed|failure|bad|wrong|invalid)\W*$/i,
];

const STATUS_PROPERTIES = new Set(["status", "statuscode"]);

function nodeSource(node: Node, source: string): string {
  return source.slice(node.start, node.end);
}

function propertyKeyName(source: string, key: Node): string {
  return source.slice(key.start, key.end).replaceAll(/["']/g, "");
}

function caughtName(handler: CatchClause): string | null {
  return handler.param?.type === "Identifier" ? handler.param.name : null;
}

function enclosingCaughtNames(
  node: NodeRange,
  handlers: { handler: CatchClause; body: NodeRange }[],
): string[] {
  return handlers
    .filter(({ body }) => containsNode(body, node))
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

type ErrorMarkers = {
  hasCode: boolean;
  hasCause: boolean;
  hasStatus: boolean;
};

function collectMarkerProperties(argument: Expression, program: Program, source: string): ErrorMarkers {
  let hasCode = false;
  let hasCause = false;
  let hasStatus = false;
  new Visitor({
    Property(node) {
      if (!containsNode(argument, node)) return;
      const key = propertyKeyName(source, node.key).toLowerCase();
      if (key === "code") hasCode = true;
      else if (key === "cause") hasCause = true;
      else if (STATUS_PROPERTIES.has(key)) hasStatus = true;
    },
  }).visit(program);
  return { hasCode, hasCause, hasStatus };
}

function thrownTypeName(argument: Expression, source: string): string | null {
  if (argument.type !== "NewExpression" && argument.type !== "CallExpression") return null;
  return nodeSource(argument.callee, source);
}

function stringLiteralText(node: Expression): string | null {
  if (node.type !== "Literal") return null;
  const raw = node.raw;
  if (raw === null || raw.length < 2) return null;
  const quote = raw[0];
  if ((quote !== "\"" && quote !== "'") || !raw.endsWith(quote)) return null;
  return raw.slice(1, -1);
}

function messageText(argument: Expression, source: string): string | null {
  if (argument.type !== "NewExpression" && argument.type !== "CallExpression") return null;
  const first = argument.arguments.find((item) => item.type !== "SpreadElement");
  if (!first) return null;
  if (first.type === "Literal") return stringLiteralText(first);
  if (first.type === "TemplateLiteral") {
    return source.slice(first.start, first.end);
  }
  return null;
}

function isGenericMessageText(text: string | null, hasNoMessage: boolean): boolean {
  if (text === null) return hasNoMessage;
  return GENERIC_MESSAGE_PATTERNS.some((pattern) => pattern.test(text));
}

function classifyErrorValue(
  operation: string,
  argument: Expression | null,
  caughtNames: string[],
  program: Program,
  source: string,
): IndiscriminableThrownError {
  if (argument === null) {
    return {
      operation,
      thrownType: null,
      kind: "indiscriminable",
      isBareError: false,
      hasCode: false,
      hasCause: false,
      hasStatus: false,
      isGenericMessage: true,
      referencesCaughtError: false,
    };
  }

  const referencesCaughtError = caughtNames.some((name) =>
    referencesIdentifier(program, argument, name)
  );
  if (argument.type === "Identifier" && caughtNames.includes(argument.name)) {
    return {
      operation,
      thrownType: null,
      kind: "bare-rethrow",
      isBareError: false,
      hasCode: false,
      hasCause: false,
      hasStatus: false,
      isGenericMessage: false,
      referencesCaughtError: true,
    };
  }

  if (argument.type === "NewExpression" || argument.type === "CallExpression") {
    const thrownType = thrownTypeName(argument, source);
    const markers = collectMarkerProperties(argument, program, source);
    const text = messageText(argument, source);
    const args = argument.arguments.filter((item) => item.type !== "SpreadElement");
    const interpolated = hasInterpolationValue(argument, program);
    const isBareError = thrownType === "Error";
    const discriminated = markers.hasCode
      || markers.hasCause
      || markers.hasStatus
      || (thrownType !== null && thrownType !== "Error");
    return {
      operation,
      thrownType,
      kind: discriminated ? "discriminated" : "indiscriminable",
      isBareError,
      hasCode: markers.hasCode,
      hasCause: markers.hasCause,
      hasStatus: markers.hasStatus,
      isGenericMessage: interpolated ? false : isGenericMessageText(text, args.length === 0),
      referencesCaughtError,
    };
  }

  if (argument.type === "ObjectExpression") {
    const markers = collectMarkerProperties(argument, program, source);
    const discriminated = markers.hasCode || markers.hasCause || markers.hasStatus;
    return {
      operation,
      thrownType: null,
      kind: discriminated ? "discriminated" : "other",
      isBareError: false,
      hasCode: markers.hasCode,
      hasCause: markers.hasCause,
      hasStatus: markers.hasStatus,
      isGenericMessage: false,
      referencesCaughtError,
    };
  }

  return {
    operation,
    thrownType: null,
    kind: "other",
    isBareError: false,
    hasCode: false,
    hasCause: false,
    hasStatus: false,
    isGenericMessage: false,
    referencesCaughtError,
  };
}

function isPromiseRejectCall(node: CallExpression): boolean {
  return node.callee.type === "MemberExpression"
    && !node.callee.computed
    && node.callee.object.type === "Identifier"
    && node.callee.object.name === "Promise"
    && node.callee.property.type === "Identifier"
    && node.callee.property.name === "reject";
}

function callsFunction(block: NodeRange, name: string, program: Program): boolean {
  let calls = false;
  new Visitor({
    CallExpression(node) {
      if (!containsNode(block, node)) return;
      if (node.callee.type === "Identifier" && node.callee.name === name) calls = true;
    },
  }).visit(program);
  return calls;
}

function discriminantChecks(handler: CatchClause, program: Program): string[] {
  const checks = new Set<string>();
  const body: NodeRange = handler.body;
  new Visitor({
    BinaryExpression(node) {
      if (!containsNode(body, node)) return;
      if (node.operator === "instanceof") checks.add("instanceof");
    },
    MemberExpression(node) {
      if (!containsNode(body, node)) return;
      if (node.property.type !== "Identifier") return;
      const key = node.property.name.toLowerCase();
      if (key === "code") checks.add("code");
      else if (key === "status" || key === "statuscode") checks.add("status");
      else if (key === "name") checks.add("name");
    },
  }).visit(program);
  return [...checks].sort();
}

function findDiscriminatingHandlers(
  name: string,
  projectFiles: ProjectFile[],
): DiscriminatingHandler[] {
  const handlers: DiscriminatingHandler[] = [];
  for (const file of projectFiles) {
    const parsed = parseCached(file.filePath, file.source);
    if (parsed.errors.some((error) => error.severity === "Error")) continue;
    const visit = (statement: TryStatement): void => {
      if (!statement.handler) return;
      if (!callsFunction(statement.block, name, parsed.program)) return;
      const checks = discriminantChecks(statement.handler, parsed.program);
      if (checks.length === 0) return;
      handlers.push({
        filePath: file.filePath,
        operation: nodeSource(statement.handler, file.source),
        checks,
      });
    };
    new Visitor({ TryStatement: visit }).visit(parsed.program);
    if (handlers.length >= 20) break;
  }
  return handlers.slice(0, 20);
}

export function buildIndiscriminableErrorEvidence(
  candidate: Candidate,
  projectFiles: ProjectFile[],
): IndiscriminableErrorEvidence | undefined {
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

  const thrownErrors: IndiscriminableThrownError[] = [];
  const rejections: IndiscriminableThrownError[] = [];
  new Visitor({
    ThrowStatement(statement) {
      if (
        statement.start < fn.start
        || statement.end > fn.end
        || !belongsDirectlyToFunction(statement, nested)
      ) return;
      thrownErrors.push(classifyErrorValue(
        nodeSource(statement, ownerFile.source),
        statement.argument,
        enclosingCaughtNames(statement, handlers),
        parsed.program,
        ownerFile.source,
      ));
    },
    CallExpression(node) {
      if (
        node.start < fn.start
        || node.end > fn.end
        || !belongsDirectlyToFunction(node, nested)
      ) return;
      if (!isPromiseRejectCall(node)) return;
      const first = node.arguments.find((item) => item.type !== "SpreadElement") ?? null;
      rejections.push(classifyErrorValue(
        nodeSource(node, ownerFile.source),
        first,
        enclosingCaughtNames(node, handlers),
        parsed.program,
        ownerFile.source,
      ));
    },
  }).visit(parsed.program);

  if (thrownErrors.length === 0 && rejections.length === 0) return undefined;

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
    rejections,
    repository: {
      callers: name ? findFunctionCallers(candidate.filePath, name, projectFiles) : [],
      discriminatingHandlers: name ? findDiscriminatingHandlers(name, projectFiles) : [],
    },
  };
}
