import { Visitor } from "oxc-parser";
import { parseCached } from "./parse-cache.js";
import type { CallExpression, Node } from "oxc-parser";
import type { Candidate, ProjectFile } from "../types.js";
import { belongsDirectlyToFunction, containsNode, nestedFunctionRanges } from "./function-scope.js";
import {
  findDirectFunction,
  findFunctionCallers,
  findRelatedProjectModules,
  functionName,
  isFunctionExported,
  moduleImports,
} from "./repository.js";
import type { FunctionCaller, RelatedProjectModule } from "./repository.js";

export type SharedMemoryAccess = {
  source: string;
  view: string;
  write: boolean;
  line: number;
};

export type UnsynchronizedSharedMemoryEvidence = {
  function: {
    name: string | null;
    exported: boolean;
    filePath: string;
    source: string;
    moduleSource: string;
  };
  sharedBuffers: string[];
  views: string[];
  accesses: SharedMemoryAccess[];
  atomics: {
    present: boolean;
    calls: string[];
  };
  workerSharing: {
    present: boolean;
    evidence: string[];
  };
  messagePassing: {
    present: boolean;
    evidence: string[];
  };
  repository: {
    callers: FunctionCaller[];
    relatedModules: RelatedProjectModule[];
  };
};

const TYPED_ARRAYS = new Set([
  "Int8Array",
  "Uint8Array",
  "Uint8ClampedArray",
  "Int16Array",
  "Uint16Array",
  "Int32Array",
  "Uint32Array",
  "Float32Array",
  "Float64Array",
  "BigInt64Array",
  "BigUint64Array",
]);
const ATOMICS_METHODS = new Set([
  "load",
  "store",
  "add",
  "sub",
  "and",
  "or",
  "xor",
  "exchange",
  "compareExchange",
  "isLockFree",
  "wait",
  "notify",
]);
const WORKER_IMPORT_PATTERN = /worker_threads/i;
const WORKER_EVIDENCE_PATTERN = /new\s+Worker\s*\(|Worker\s*\(|postMessage|workerData/i;
const MESSAGE_PASSING_PATTERN = /postMessage|MessageChannel|MessagePort|BroadcastChannel|on\s*\(\s*["']message["']/i;

function nodeSource(node: Node, source: string): string {
  return source.slice(node.start, node.end);
}

function lineAt(source: string, offset: number): number {
  let line = 1;
  for (let index = 0; index < offset; index += 1) {
    if (source[index] === "\n") line += 1;
  }
  return line;
}

function newTargetName(node: { callee: CallExpression["callee"] }): string | undefined {
  if (node.callee.type === "Identifier") return node.callee.name;
  return undefined;
}

function isComputedMemberOn(node: Node, views: Set<string>): string | undefined {
  if (
    node.type === "MemberExpression"
    && node.computed
    && node.object.type === "Identifier"
    && views.has(node.object.name)
  ) return node.object.name;
  if (
    node.type === "ChainExpression"
    && node.expression.type === "MemberExpression"
    && node.expression.computed
    && node.expression.object.type === "Identifier"
    && views.has(node.expression.object.name)
  ) return node.expression.object.name;
  return undefined;
}

export function buildUnsynchronizedSharedMemoryEvidence(
  candidate: Candidate,
  projectFiles: ProjectFile[],
): UnsynchronizedSharedMemoryEvidence | undefined {
  if (candidate.kind !== "function") return undefined;
  const ownerFile = projectFiles.find((file) => file.filePath === candidate.filePath);
  if (!ownerFile) return undefined;
  const parsed = parseCached(ownerFile.filePath, ownerFile.source);
  if (parsed.errors.some((error) => error.severity === "Error")) return undefined;
  const fn = findDirectFunction(parsed.program, candidate);
  if (!fn) return undefined;
  const nested = nestedFunctionRanges(parsed.program, fn);
  const source = ownerFile.source;

  const inScope = (node: Node): boolean =>
    containsNode(fn, node) && belongsDirectlyToFunction(node, nested);

  const sharedBuffers: string[] = [];
  const views: string[] = [];
  const viewNames = new Set<string>();
  new Visitor({
    NewExpression(node) {
      const target = newTargetName(node);
      if (target === "SharedArrayBuffer") {
        sharedBuffers.push(nodeSource(node, source).slice(0, 200));
        return;
      }
      if (target && TYPED_ARRAYS.has(target)) {
        views.push(nodeSource(node, source).slice(0, 200));
      }
    },
    VariableDeclarator(node) {
      if (node.id.type !== "Identifier" || !node.init) return;
      const init = node.init.type === "ChainExpression" ? node.init.expression : node.init;
      if (init.type !== "NewExpression" || init.callee.type !== "Identifier") return;
      if (!TYPED_ARRAYS.has(init.callee.name)) return;
      viewNames.add(node.id.name);
    },
  }).visit(parsed.program);

  for (const parameter of fn.params) {
    const text = source.slice(parameter.start, parameter.end);
    const match = /^[A-Za-z_$][\w$]*/.exec(text);
    if (match?.[0] && /shared|sab|buffer|view/i.test(match[0])) viewNames.add(match[0]);
  }

  const imports = moduleImports(parsed.program);
  const workerEvidence = [...source.matchAll(new RegExp(WORKER_EVIDENCE_PATTERN, "g"))]
    .map((match) => source.slice(Math.max(0, (match.index ?? 0) - 40), (match.index ?? 0) + 80))
    .slice(0, 10);
  const workerSharingPresent = imports.some(({ source: specifier }) => WORKER_IMPORT_PATTERN.test(specifier))
    || /new\s+Worker\s*\(/.test(source);

  if (
    !/SharedArrayBuffer/.test(source)
    && !(workerSharingPresent && views.length > 0)
  ) return undefined;

  const writeTargets = new Set<string>();
  new Visitor({
    AssignmentExpression(node) {
      if (!inScope(node)) return;
      const view = isComputedMemberOn(node.left, viewNames);
      if (view) writeTargets.add(`${view}:${node.left.start}:${node.left.end}`);
    },
    UpdateExpression(node) {
      if (!inScope(node)) return;
      if (node.argument.type !== "MemberExpression") return;
      const view = isComputedMemberOn(node.argument, viewNames);
      if (view) writeTargets.add(`${view}:${node.argument.start}:${node.argument.end}`);
    },
  }).visit(parsed.program);

  const accesses: SharedMemoryAccess[] = [];
  const seenAccesses = new Set<string>();
  const recordAccess = (node: Node, view: string, write: boolean): void => {
    if (!inScope(node)) return;
    const key = `${node.start}:${node.end}:${write ? "w" : "r"}`;
    if (seenAccesses.has(key)) return;
    seenAccesses.add(key);
    accesses.push({
      source: nodeSource(node, source).slice(0, 200),
      view,
      write,
      line: lineAt(source, node.start),
    });
  };
  new Visitor({
    AssignmentExpression(node) {
      const view = isComputedMemberOn(node.left, viewNames);
      if (view) recordAccess(node, view, true);
    },
    UpdateExpression(node) {
      if (node.argument.type !== "MemberExpression") return;
      const view = isComputedMemberOn(node.argument, viewNames);
      if (view) recordAccess(node, view, true);
    },
    MemberExpression(node) {
      if (!node.computed || node.object.type !== "Identifier" || !viewNames.has(node.object.name)) return;
      if ([...writeTargets].some((key) => key.endsWith(`:${node.start}:${node.end}`))) return;
      recordAccess(node, node.object.name, false);
    },
  }).visit(parsed.program);

  const atomicCalls: string[] = [];
  new Visitor({
    CallExpression(call) {
      const callee = call.callee.type === "ChainExpression" ? call.callee.expression : call.callee;
      if (
        callee.type !== "MemberExpression"
        || callee.object.type !== "Identifier"
        || callee.object.name !== "Atomics"
        || callee.property.type !== "Identifier"
        || !ATOMICS_METHODS.has(callee.property.name)
      ) return;
      atomicCalls.push(nodeSource(call, source).slice(0, 200));
    },
  }).visit(parsed.program);

  const messageEvidence = [...source.matchAll(new RegExp(MESSAGE_PASSING_PATTERN, "g"))]
    .map((match) => source.slice(Math.max(0, (match.index ?? 0) - 40), (match.index ?? 0) + 80))
    .slice(0, 10);
  const name = functionName(parsed.program, fn);
  return {
    function: {
      name: name ?? null,
      exported: name ? isFunctionExported(parsed.program, fn, name) : false,
      filePath: candidate.filePath,
      source: candidate.source,
      moduleSource: source.slice(0, 16_000),
    },
    sharedBuffers,
    views,
    accesses,
    atomics: {
      present: atomicCalls.length > 0,
      calls: atomicCalls.slice(0, 10),
    },
    workerSharing: {
      present: workerSharingPresent,
      evidence: workerEvidence,
    },
    messagePassing: {
      present: messageEvidence.length > 0,
      evidence: messageEvidence,
    },
    repository: {
      callers: name ? findFunctionCallers(candidate.filePath, name, projectFiles) : [],
      relatedModules: findRelatedProjectModules(candidate.filePath, parsed.program, projectFiles),
    },
  };
}
