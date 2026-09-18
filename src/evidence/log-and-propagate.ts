import { Visitor } from "oxc-parser";
import { parseCached } from "./parse-cache.js";
import type {
  BindingPattern,
  CallExpression,
  Node,
  ParamPattern,
  Program,
} from "oxc-parser";
import type { Candidate, ProjectFile } from "../types.js";
import { containsNode } from "./function-scope.js";
import type { NodeRange } from "./function-scope.js";
import {
  findDirectFunction,
  findFunctionCallers,
  functionName,
  isFunctionExported,
  nestedFunctionRanges,
} from "./repository.js";
import type { FunctionCaller } from "./repository.js";

export type LogAndPropagateHandler = {
  kind: "try-catch" | "catch-callback";
  caught: string | null;
  tryBlock: string | null;
  catchBody: string;
  logCalls: string[];
  propagations: string[];
  logsCaughtError: boolean;
  propagatesCaughtError: boolean;
};

export type CallerFailureHandling = {
  filePath: string;
  call: string;
  line: number;
  recordsFailure: boolean;
  recordExcerpt: string | null;
};

export type LogAndPropagateEvidence = {
  function: {
    name: string | null;
    exported: boolean;
    filePath: string;
    source: string;
  };
  handlers: LogAndPropagateHandler[];
  enclosingLoggingHandlers: string[];
  callers: CallerFailureHandling[];
};

const LOG_METHODS = new Set([
  "log",
  "debug",
  "info",
  "warn",
  "warning",
  "error",
  "trace",
  "fatal",
  "exception",
  "capture",
  "captureException",
  "captureMessage",
  "report",
  "reportError",
  "track",
  "trackException",
  "record",
  "recordError",
  "recordException",
  "emit",
  "send",
  "logError",
  "logException",
]);

const LOG_RECEIVERS = new Set([
  "console",
  "logger",
  "log",
  "telemetry",
  "metrics",
  "metric",
  "monitor",
  "sentry",
  "bugsnag",
  "datadog",
  "tracer",
  "reporter",
  "audit",
  "logging",
]);

function patternName(pattern: BindingPattern | ParamPattern): string | null {
  const value = pattern.type === "TSParameterProperty" ? pattern.parameter : pattern;
  if (value.type === "Identifier") return value.name;
  if (value.type === "AssignmentPattern" && value.left.type === "Identifier") {
    return value.left.name;
  }
  if (value.type === "RestElement" && value.argument.type === "Identifier") {
    return value.argument.name;
  }
  return null;
}

function isLoggingCall(call: CallExpression): boolean {
  const callee = call.callee;
  if (callee.type === "MemberExpression") {
    return callee.property.type === "Identifier" && LOG_METHODS.has(callee.property.name);
  }
  if (callee.type === "Identifier") {
    return LOG_METHODS.has(callee.name) || LOG_RECEIVERS.has(callee.name);
  }
  return false;
}

function referencesBinding(range: NodeRange, name: string, program: Program): boolean {
  let found = false;
  new Visitor({
    Identifier(node) {
      if (node.name === name && containsNode(range, node)) found = true;
    },
  }).visit(program);
  return found;
}

function argumentRange(call: CallExpression): NodeRange | null {
  const first = call.arguments[0];
  const last = call.arguments[call.arguments.length - 1];
  if (!first || !last) return null;
  return { start: first.start, end: last.end };
}

function bodyLogs(body: NodeRange, program: Program): boolean {
  let found = false;
  new Visitor({
    CallExpression(node) {
      if (containsNode(body, node) && isLoggingCall(node)) found = true;
    },
  }).visit(program);
  return found;
}

function lineStartOffset(source: string, line: number): number {
  let offset = 0;
  let current = 1;
  while (current < line) {
    const newline = source.indexOf("\n", offset);
    if (newline === -1) return source.length;
    offset = newline + 1;
    current += 1;
  }
  return offset;
}

function callerHandling(
  callerFile: ProjectFile | undefined,
  caller: FunctionCaller,
): CallerFailureHandling {
  const base: CallerFailureHandling = {
    filePath: caller.filePath,
    call: caller.call,
    line: caller.line,
    recordsFailure: false,
    recordExcerpt: null,
  };
  if (!callerFile) return base;
  const parsed = parseCached(callerFile.filePath, callerFile.source);
  if (parsed.errors.some((error) => error.severity === "Error")) return base;
  const offset = lineStartOffset(callerFile.source, caller.line);
  let excerpt: string | null = null;
  new Visitor({
    TryStatement(statement) {
      if (excerpt || !statement.handler) return;
      if (
        statement.start <= offset
        && statement.end >= offset
        && bodyLogs(statement.handler.body, parsed.program)
      ) {
        excerpt = callerFile.source.slice(
          statement.handler.body.start,
          statement.handler.body.end,
        );
      }
    },
    CallExpression(node) {
      if (excerpt) return;
      if (node.callee.type !== "MemberExpression") return;
      if (node.callee.property.type !== "Identifier") return;
      if (node.callee.property.name !== "catch") return;
      const [callback] = node.arguments;
      if (!callback) return;
      if (callback.type !== "ArrowFunctionExpression" && callback.type !== "FunctionExpression") {
        return;
      }
      if (!callback.body || callback.body.type !== "BlockStatement") return;
      const receiver = node.callee.object;
      if (
        receiver.start <= offset
        && receiver.end >= offset
        && bodyLogs(callback.body, parsed.program)
      ) {
        excerpt = callerFile.source.slice(callback.body.start, callback.body.end);
      }
    },
  }).visit(parsed.program);
  if (!excerpt) return base;
  return { ...base, recordsFailure: true, recordExcerpt: excerpt };
}

type PendingHandler = {
  kind: "try-catch" | "catch-callback";
  caught: string | null;
  tryBlock: string | null;
  body: NodeRange;
  callback: NodeRange | null;
};

function nodeSource(node: Node, source: string): string {
  return source.slice(node.start, node.end);
}

export function buildLogAndPropagateEvidence(
  candidate: Candidate,
  projectFiles: ProjectFile[],
): LogAndPropagateEvidence | undefined {
  if (candidate.kind !== "function") return undefined;
  const ownerFile = projectFiles.find((file) => file.filePath === candidate.filePath);
  if (!ownerFile) return undefined;
  const parsed = parseCached(ownerFile.filePath, ownerFile.source);
  if (parsed.errors.some((error) => error.severity === "Error")) return undefined;
  const fn = findDirectFunction(parsed.program, candidate);
  if (!fn) return undefined;

  const nested = nestedFunctionRanges(parsed.program, candidate);
  const direct = (node: NodeRange): boolean =>
    node.start >= candidate.start
    && node.end <= candidate.end
    && !nested.some((range) => containsNode(range, node));

  const pending: PendingHandler[] = [];
  new Visitor({
    TryStatement(statement) {
      if (!direct(statement) || !statement.handler) return;
      pending.push({
        kind: "try-catch",
        caught: statement.handler.param ? patternName(statement.handler.param) : null,
        tryBlock: nodeSource(statement.block, ownerFile.source),
        body: { start: statement.handler.body.start, end: statement.handler.body.end },
        callback: null,
      });
    },
    CallExpression(node) {
      if (!direct(node)) return;
      if (node.callee.type !== "MemberExpression") return;
      if (node.callee.property.type !== "Identifier") return;
      if (node.callee.property.name !== "catch") return;
      const [callback] = node.arguments;
      if (!callback) return;
      if (callback.type !== "ArrowFunctionExpression" && callback.type !== "FunctionExpression") {
        return;
      }
      if (!callback.body || callback.body.type !== "BlockStatement") return;
      const [firstParam] = callback.params;
      pending.push({
        kind: "catch-callback",
        caught: firstParam ? patternName(firstParam) : null,
        tryBlock: nodeSource(node.callee.object, ownerFile.source),
        body: { start: callback.body.start, end: callback.body.end },
        callback: { start: callback.start, end: callback.end },
      });
    },
  }).visit(parsed.program);
  if (pending.length === 0) return undefined;

  const handlers: LogAndPropagateHandler[] = pending.map((handler) => {
    const inScope = (node: NodeRange): boolean =>
      containsNode(handler.body, node)
      && !nested.some((range) =>
        (handler.callback === null
          || range.start !== handler.callback.start
          || range.end !== handler.callback.end)
        && containsNode(range, node));

    const logCalls: string[] = [];
    const propagations: string[] = [];
    let logsCaught = false;
    let propagatesCaught = false;
    new Visitor({
      CallExpression(node) {
        if (!inScope(node) || !handler.caught) return;
        const args = argumentRange(node);
        if (!args || !referencesBinding(args, handler.caught, parsed.program)) return;
        if (isLoggingCall(node)) {
          logCalls.push(nodeSource(node, ownerFile.source));
          logsCaught = true;
          return;
        }
        if (
          node.callee.type === "MemberExpression"
          && node.callee.property.type === "Identifier"
          && node.callee.property.name === "reject"
        ) {
          propagations.push(nodeSource(node, ownerFile.source));
          propagatesCaught = true;
        }
      },
      ThrowStatement(node) {
        if (!inScope(node) || !handler.caught) return;
        if (referencesBinding(node.argument, handler.caught, parsed.program)) {
          propagations.push(nodeSource(node, ownerFile.source));
          propagatesCaught = true;
        }
      },
      ReturnStatement(node) {
        if (!inScope(node) || !handler.caught || !node.argument) return;
        if (referencesBinding(node.argument, handler.caught, parsed.program)) {
          propagations.push(nodeSource(node, ownerFile.source));
          propagatesCaught = true;
        }
      },
    }).visit(parsed.program);

    return {
      kind: handler.kind,
      caught: handler.caught,
      tryBlock: handler.tryBlock,
      catchBody: ownerFile.source.slice(handler.body.start, handler.body.end),
      logCalls,
      propagations,
      logsCaughtError: logsCaught,
      propagatesCaughtError: propagatesCaught,
    };
  });

  if (!handlers.some((handler) => handler.logsCaughtError && handler.propagatesCaughtError)) {
    return undefined;
  }

  const enclosingLoggingHandlers: string[] = [];
  new Visitor({
    TryStatement(statement) {
      if (!statement.handler) return;
      if (statement.start > candidate.start || statement.end < candidate.end) return;
      if (statement.start === candidate.start && statement.end === candidate.end) return;
      if (bodyLogs(statement.handler.body, parsed.program)) {
        enclosingLoggingHandlers.push(nodeSource(statement.handler.body, ownerFile.source));
      }
    },
  }).visit(parsed.program);

  const name = functionName(parsed.program, fn);
  const callers = name ? findFunctionCallers(candidate.filePath, name, projectFiles) : [];
  const callerFiles = new Map(projectFiles.map((file) => [file.filePath, file]));

  return {
    function: {
      name: name ?? null,
      exported: name ? isFunctionExported(parsed.program, fn, name) : false,
      filePath: candidate.filePath,
      source: candidate.source,
    },
    handlers,
    enclosingLoggingHandlers,
    callers: callers.map((caller) => callerHandling(callerFiles.get(caller.filePath), caller)),
  };
}
