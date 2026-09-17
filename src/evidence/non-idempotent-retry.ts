import { parseSync, Visitor } from "oxc-parser";
import type { CallExpression, DoWhileStatement, ForStatement, Node, Program, WhileStatement } from "oxc-parser";
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

type RetryLoop = ForStatement | WhileStatement | DoWhileStatement;

export type RetriedOperation = {
  kind: "loop" | "retry-call";
  source: string;
  wrappedCalls: string[];
  mutatingSinks: string[];
  idempotencySignals: string[];
};

export type NonIdempotentRetryEvidence = {
  function: {
    name: string | null;
    exported: boolean;
    filePath: string;
    source: string;
    moduleSource: string;
  };
  retries: RetriedOperation[];
  repository: {
    callers: FunctionCaller[];
    relatedModules: RelatedProjectModule[];
  };
};

const MUTATING_SINK = /charge|pay|send|publish|post|create|update|delete|write|insert|upsert|enqueu|dispatch|notify|email|purchase|refund|transfer|mutat|persist/i;
const READ_OPERATION = /^(get|fetch|load|read|query|select|list|find|describe|check|verify|peek|has|exists)$/;
const IDEMPOTENCY_SIGNAL = /idempoten|Idempotency-Key|requestId|dedupe|idempotencyKey|idempotency/i;

function nodeSource(node: Node, source: string): string {
  return source.slice(node.start, node.end);
}

function finalName(callee: CallExpression["callee"]): string | null {
  if (callee.type === "Identifier") return callee.name;
  if (callee.type === "MemberExpression") {
    if (callee.property.type === "Identifier") return callee.property.name;
    if (callee.property.type === "Literal") return String(callee.property.value);
  }
  return null;
}

function isRetryCall(call: CallExpression): boolean {
  const name = finalName(call.callee);
  return name !== null && /retry/i.test(name);
}

function isMutatingSink(call: CallExpression, source: string): boolean {
  const name = finalName(call.callee);
  if (name && MUTATING_SINK.test(name)) return true;
  if (name === "fetch" && /method\s*:\s*["']POST|method\s*:\s*["'](PUT|PATCH|DELETE)/.test(nodeSource(call, source))) {
    return true;
  }
  return false;
}

function isReadOperation(call: CallExpression): boolean {
  const name = finalName(call.callee);
  return name !== null && READ_OPERATION.test(name);
}

function signalsIn(
  range: NodeRange,
  program: Program,
  nested: NodeRange[],
): string[] {
  const signals = new Set<string>();
  new Visitor({
    Identifier(node) {
      if (
        containsNode(range, node)
        && belongsDirectlyToFunction(node, nested)
        && IDEMPOTENCY_SIGNAL.test(node.name)
      ) signals.add(node.name);
    },
  }).visit(program);
  return [...signals];
}

function callsIn(
  range: NodeRange,
  program: Program,
  nested: NodeRange[],
): CallExpression[] {
  const calls: CallExpression[] = [];
  new Visitor({
    CallExpression(call) {
      if (containsNode(range, call) && belongsDirectlyToFunction(call, nested)) calls.push(call);
    },
  }).visit(program);
  return calls;
}

function callsWithinSpan(
  range: NodeRange,
  program: Program,
  exclude: CallExpression,
): CallExpression[] {
  const calls: CallExpression[] = [];
  new Visitor({
    CallExpression(call) {
      if (call !== exclude && containsNode(range, call)) calls.push(call);
    },
  }).visit(program);
  return calls;
}

function signalsWithinSpan(range: NodeRange, program: Program): string[] {
  const signals = new Set<string>();
  new Visitor({
    Identifier(node) {
      if (containsNode(range, node) && IDEMPOTENCY_SIGNAL.test(node.name)) {
        signals.add(node.name);
      }
    },
  }).visit(program);
  return [...signals];
}
function catchesIn(
  range: NodeRange,
  program: Program,
  nested: NodeRange[],
): boolean {
  let found = false;
  new Visitor({
    CatchClause(handler) {
      if (containsNode(range, handler) && belongsDirectlyToFunction(handler, nested)) found = true;
    },
  }).visit(program);
  return found;
}

export function buildNonIdempotentRetryEvidence(
  candidate: Candidate,
  projectFiles: ProjectFile[],
): NonIdempotentRetryEvidence | undefined {
  if (candidate.kind !== "function") return undefined;
  const ownerFile = projectFiles.find((file) => file.filePath === candidate.filePath);
  if (!ownerFile) return undefined;
  const parsed = parseSync(ownerFile.filePath, ownerFile.source, { range: true });
  if (parsed.errors.some((error) => error.severity === "Error")) return undefined;
  const fn = findDirectFunction(parsed.program, candidate);
  if (!fn) return undefined;

  const nested = nestedFunctionRanges(parsed.program, fn);
  const retries: RetriedOperation[] = [];
  const inScope = (node: Node): boolean =>
    containsNode(fn, node) && belongsDirectlyToFunction(node, nested);

  const addLoop = (loop: RetryLoop): void => {
    if (!inScope(loop) || !catchesIn(loop, parsed.program, nested)) return;
    const calls = callsIn(loop, parsed.program, nested);
    const wrapped = calls.map((call) => nodeSource(call, ownerFile.source).slice(0, 200));
    const sinks = calls
      .filter((call) => isMutatingSink(call, ownerFile.source))
      .map((call) => nodeSource(call, ownerFile.source).slice(0, 200));
    if (sinks.length === 0) return;
    retries.push({
      kind: "loop",
      source: nodeSource(loop, ownerFile.source).slice(0, 500),
      wrappedCalls: wrapped.slice(0, 8),
      mutatingSinks: sinks.slice(0, 8),
      idempotencySignals: signalsIn(loop, parsed.program, nested),
    });
  };
  new Visitor({
    DoWhileStatement: addLoop,
    ForStatement: addLoop,
    WhileStatement: addLoop,
  }).visit(parsed.program);

  new Visitor({
    CallExpression(call) {
      if (!inScope(call) || !isRetryCall(call)) return;
      const inner = callsWithinSpan(call, parsed.program, call);
      const sinks = inner.filter((nestedCall) => isMutatingSink(nestedCall, ownerFile.source));
      const readsOnly = inner.length > 0 && inner.every(isReadOperation);
      if (sinks.length === 0 || readsOnly) return;
      retries.push({
        kind: "retry-call",
        source: nodeSource(call, ownerFile.source).slice(0, 500),
        wrappedCalls: inner
          .map((nestedCall) => nodeSource(nestedCall, ownerFile.source).slice(0, 200))
          .slice(0, 8),
        mutatingSinks: sinks
          .map((sink) => nodeSource(sink, ownerFile.source).slice(0, 200))
          .slice(0, 8),
        idempotencySignals: signalsWithinSpan(call, parsed.program),
      });
    },
  }).visit(parsed.program);
  if (retries.length === 0) return undefined;

  const name = functionName(parsed.program, fn);
  return {
    function: {
      name: name ?? null,
      exported: name ? isFunctionExported(parsed.program, fn, name) : false,
      filePath: candidate.filePath,
      source: candidate.source,
      moduleSource: ownerFile.source.slice(0, 16_000),
    },
    retries,
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
