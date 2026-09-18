import { Visitor } from "oxc-parser";
import { parseCached } from "./parse-cache.js";
import type { CallExpression, Node, Program } from "oxc-parser";
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

export type QueueProducerCall = {
  call: string;
  method: string;
  receiver: string | null;
  importedFrom: string | null;
  awaited: boolean;
  resultConsumed: boolean;
  guarded: boolean;
};

export type SilentQueueDropEvidence = {
  function: {
    name: string | null;
    exported: boolean;
    filePath: string;
    source: string;
    moduleSource: string;
  };
  producerCalls: QueueProducerCall[];
  pressurePolicy: {
    drainListener: string | null;
    overflowPolicy: string | null;
  };
  queueClient: {
    source: string | null;
    local: string | null;
  };
  repository: {
    callers: FunctionCaller[];
    relatedModules: RelatedProjectModule[];
  };
};

const QUEUE_SPECIFIC_METHOD_PATTERN = /^(?:publish|enqueue|produce|offer|addJob|sendBatch)$/i;
const PRODUCER_METHOD_PATTERN = /^(?:send|publish|enqueue|produce|push|offer|add|dispatch|emit)$/i;
const QUEUE_RECEIVER_PATTERN = /queue|channel|topic|bus|stream|broker|producer|sender|mailbox/i;
const DRAIN_PATTERN = /["']drain["']|onBackpressure|waitForDrain/i;
const OVERFLOW_PATTERN = /highWaterMark|maxsize|maxSize|maxQueue|drop-oldest|dropOldest|overflow|backpressure|shedLoad/i;

function nodeSource(node: Node, source: string): string {
  return source.slice(node.start, node.end);
}

function finalPropertyName(call: CallExpression): string | null {
  const callee = call.callee.type === "ChainExpression" ? call.callee.expression : call.callee;
  if (callee.type === "MemberExpression") {
    if (callee.property.type === "Identifier") return callee.property.name;
    if (callee.property.type === "Literal") return String(callee.property.value);
  }
  return null;
}

function isProducerCall(
  call: CallExpression,
  imports: { source: string; local: string }[],
): { method: string } | undefined {
  const method = finalPropertyName(call)
    ?? (call.callee.type === "Identifier" ? call.callee.name : undefined);
  if (!method || !PRODUCER_METHOD_PATTERN.test(method)) return undefined;
  if (QUEUE_SPECIFIC_METHOD_PATTERN.test(method)) return { method };
  const root = calleeRootName(call.callee);
  const imported = root ? imports.find(({ local }) => local === root) : undefined;
  if (root && QUEUE_RECEIVER_PATTERN.test(root)) return { method };
  if (imported && QUEUE_RECEIVER_PATTERN.test(imported.source)) return { method };
  return undefined;
}

function moduleLineMatching(source: string, pattern: RegExp): string | null {
  for (const line of source.split("\n")) {
    if (pattern.test(line)) return line.trim().slice(0, 240);
  }
  return null;
}

export function buildSilentQueueDropEvidence(
  candidate: Candidate,
  projectFiles: ProjectFile[],
): SilentQueueDropEvidence | undefined {
  if (candidate.kind !== "function") return undefined;
  const ownerFile = projectFiles.find((file) => file.filePath === candidate.filePath);
  if (!ownerFile) return undefined;
  const parsed = parseCached(ownerFile.filePath, ownerFile.source);
  if (parsed.errors.some((error) => error.severity === "Error")) return undefined;
  const fn: FunctionNode | undefined = findDirectFunction(parsed.program, candidate);
  if (!fn) return undefined;

  const nested = nestedFunctionRanges(parsed.program, fn);
  const direct = (node: NodeRange): boolean =>
    node.start >= fn.start && node.end <= fn.end && belongsDirectlyToFunction(node, nested);
  const program: Program = parsed.program;
  const source = ownerFile.source;

  const producerRanges: { call: CallExpression; method: string }[] = [];
  const imports = moduleImports(program);
  new Visitor({
    CallExpression(node: CallExpression) {
      if (!direct(node)) return;
      const producer = isProducerCall(node, imports);
      if (!producer) return;
      producerRanges.push({ call: node, method: producer.method });
    },
  }).visit(program);
  if (producerRanges.length === 0) return undefined;

  const awaited: NodeRange[] = [];
  const consumed: NodeRange[] = [];
  const guarded: NodeRange[] = [];
  new Visitor({
    AwaitExpression(node) {
      if (direct(node)) awaited.push(node);
    },
    VariableDeclarator(node) {
      if (direct(node) && node.init) consumed.push(node.init);
    },
    AssignmentExpression(node) {
      if (direct(node)) consumed.push(node.right);
    },
    ReturnStatement(node) {
      if (direct(node) && node.argument) consumed.push(node.argument);
    },
    IfStatement(node) {
      if (direct(node)) consumed.push(node.test);
    },
    ConditionalExpression(node) {
      if (direct(node)) consumed.push(node.test);
    },
    LogicalExpression(node) {
      if (direct(node)) consumed.push(node);
    },
    TryStatement(node) {
      if (direct(node)) guarded.push(node.block);
    },
  }).visit(program);

  const producerCalls: QueueProducerCall[] = producerRanges.map(({ call, method }) => {    const root = calleeRootName(call.callee);
    const imported = root ? imports.find(({ local }) => local === root) : undefined;
    return {
      call: nodeSource(call, source),
      method,
      receiver: root,
      importedFrom: imported?.source ?? null,
      awaited: awaited.some((range) => containsNode(range, call)),
      resultConsumed: consumed.some((range) => containsNode(range, call)),
      guarded: guarded.some((range) => containsNode(range, call)),
    };
  });

  const queueImport = imports.find(
    ({ local, source: from }) => QUEUE_RECEIVER_PATTERN.test(local) || QUEUE_RECEIVER_PATTERN.test(from),
  );

  const name = functionName(program, fn);
  return {
    function: {
      name: name ?? null,
      exported: name ? isFunctionExported(program, fn, name) : false,
      filePath: candidate.filePath,
      source: candidate.source,
      moduleSource: source.slice(0, 16_000),
    },
    producerCalls,
    pressurePolicy: {
      drainListener: moduleLineMatching(source, DRAIN_PATTERN),
      overflowPolicy: moduleLineMatching(source, OVERFLOW_PATTERN),
    },
    queueClient: {
      source: queueImport?.source ?? null,
      local: queueImport?.local ?? null,
    },
    repository: {
      callers: name ? findFunctionCallers(candidate.filePath, name, projectFiles) : [],
      relatedModules: findRelatedProjectModules(candidate.filePath, program, projectFiles),
    },
  };
}
