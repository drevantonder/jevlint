import { parseSync, Visitor } from "oxc-parser";
import type { Expression } from "oxc-parser";
import type { Candidate, ProjectFile } from "../types.js";
import {
  findDirectFunction,
  findFunctionCallers,
  functionName,
  isFunctionExported,
  nestedFunctionRanges,
} from "./repository.js";
import type { FunctionCaller } from "./repository.js";

export type PerfMachineryKind =
  | "memo-hook"
  | "memo-component"
  | "memoize-call"
  | "cache-store"
  | "batch-layer"
  | "pool-layer"
  | "custom-comparator";

export type PerfMachinery = {
  expression: string;
  kind: PerfMachineryKind;
  line: number;
};

export type UnmeasuredPerformanceMachineryEvidence = {
  function: {
    name: string;
    exported: boolean;
    filePath: string;
    source: string;
  };
  machinery: PerfMachinery[];
  invalidationPolicy: string | null;
  wrappedLooksCheap: boolean;
  perfEvidenceInRepo: string[];
  callers: FunctionCaller[];
};

const MEMO_HOOK_PATTERN = /^(useMemo|useCallback)$/;
const MEMO_COMPONENT_PATTERN = /^(memo|React\.memo)$/;
const MEMOIZE_CALL_PATTERN = /memoize|memoise|once$/i;
const CACHE_STORE_PATTERN = /^(Map|WeakMap|LRUCache|Cache|TTLCache)$/;
const CACHE_HOLDER_PATTERN = /cache|store|lru|memo/i;
const CACHE_METHOD_PATTERN = /^(get|set|has)$/;
const BATCH_PATTERN = /batch|debounce|throttle|queueMicrotask|dataloader/i;
const POOL_PATTERN = /pool|Pool|pLimit|p-limit|concurrency/i;
const INVALIDATION_PATTERN = /ttl|maxAge|staleTime|gcTime|expires|evict|invalidate|maxEntries|maxSize|clear\(\)/i;
const PERF_REFERENCE_PATTERN = /benchmark|bench\.|profiling|flamegraph|lighthouse|clinic\.js|hotspot|perf test/i;

function lineAt(source: string, offset: number): number {
  let line = 1;
  for (let index = 0; index < offset; index += 1) {
    if (source[index] === "\n") line += 1;
  }
  return line;
}

function calleeText(callee: Expression, source: string): string {
  return source.slice(callee.start, callee.end);
}

function calleeRoot(callee: Expression): string | undefined {
  if (callee.type === "Identifier") return callee.name;
  if (callee.type === "MemberExpression") {
    const object = callee.object;
    if (object.type === "Identifier") return object.name;
    if (object.type === "MemberExpression" && object.object.type === "Identifier") {
      return object.object.name;
    }
  }
  if (callee.type === "ChainExpression") return calleeRoot(callee.expression);
  return undefined;
}

export function buildUnmeasuredPerformanceMachineryEvidence(
  candidate: Candidate,
  projectFiles: ProjectFile[],
): UnmeasuredPerformanceMachineryEvidence | undefined {
  if (candidate.kind !== "function") return undefined;
  const owner = projectFiles.find((file) => file.filePath === candidate.filePath);
  if (!owner) return undefined;
  const parsed = parseSync(owner.filePath, owner.source, { range: true });
  if (parsed.errors.some((error) => error.severity === "Error")) return undefined;
  const fn = findDirectFunction(parsed.program, candidate);
  if (!fn) return undefined;
  const name = functionName(parsed.program, fn);
  if (!name) return undefined;

  const nested = nestedFunctionRanges(parsed.program, candidate);
  const inScope = (start: number, end: number): boolean =>
    start >= candidate.start && end <= candidate.end
    && !nested.some((range) => range.start <= start && range.end >= end);

  const machinery: PerfMachinery[] = [];
  const seen = new Set<string>();

  const push = (node: { start: number; end: number }, kind: PerfMachineryKind): void => {
    const key = `${kind}:${node.start}`;
    if (seen.has(key)) return;
    seen.add(key);
    machinery.push({
      expression: owner.source.slice(node.start, node.end).slice(0, 300),
      kind,
      line: lineAt(owner.source, node.start),
    });
  };

  new Visitor({
    CallExpression(call) {
      if (!inScope(call.start, call.end)) return;
      const text = calleeText(call.callee, owner.source);
      const root = calleeRoot(call.callee);
      if (root && MEMO_HOOK_PATTERN.test(root)) {
        push(call, "memo-hook");
        return;
      }
      if (MEMO_COMPONENT_PATTERN.test(text)) {
        const second = call.arguments[1];
        push(call, second ? "custom-comparator" : "memo-component");
        return;
      }
      if (root && MEMOIZE_CALL_PATTERN.test(root)) {
        push(call, "memoize-call");
        return;
      }
      if (root && CACHE_STORE_PATTERN.test(root) && call.callee.type === "NewExpression") {
        push(call, "cache-store");
        return;
      }
      if (
        call.callee.type === "MemberExpression"
        && call.callee.property.type === "Identifier"
        && CACHE_METHOD_PATTERN.test(call.callee.property.name)
        && (CACHE_STORE_PATTERN.test(root ?? "") || CACHE_HOLDER_PATTERN.test(root ?? ""))
      ) {
        push(call, "cache-store");
        return;
      }
      if (BATCH_PATTERN.test(text) || (root && BATCH_PATTERN.test(root))) {
        push(call, "batch-layer");
        return;
      }
      if (POOL_PATTERN.test(text) || (root && POOL_PATTERN.test(root))) {
        push(call, "pool-layer");
      }
    },
    NewExpression(node) {
      if (!inScope(node.start, node.end)) return;
      const text = owner.source.slice(node.callee.start, node.callee.end);
      if (CACHE_STORE_PATTERN.test(text) || POOL_PATTERN.test(text)) {
        push(node, CACHE_STORE_PATTERN.test(text) ? "cache-store" : "pool-layer");
      }
    },
  }).visit(parsed.program);

  if (machinery.length === 0) return undefined;

  const candidateText = owner.source.slice(candidate.start, candidate.end);
  const invalidationMatch = INVALIDATION_PATTERN.exec(candidateText);
  const wrappedLooksCheap = !/\bawait\b|\breturn\s+await\b|fetch\(|query\(|readFile|writeFile|createConnection|pool\.query/i
    .test(candidateText);

  const perfEvidenceInRepo: string[] = [];
  for (const file of projectFiles) {
    if (perfEvidenceInRepo.length >= 6) break;
    if (
      /\.(bench|perf|benchmark)\.[cm]?[jt]sx?$|\/__benchmarks__\/|profiling/i.test(file.filePath)
      && (file.source.includes(name) || file.source.includes(candidate.filePath))
    ) {
      perfEvidenceInRepo.push(`${file.filePath}: benchmark references ${name}`);
      continue;
    }
    if (!file.source.includes(name)) continue;
    const match = PERF_REFERENCE_PATTERN.exec(file.source);
    if (match) {
      const lineStart = file.source.lastIndexOf("\n", match.index) + 1;
      const lineEnd = file.source.indexOf("\n", match.index);
      perfEvidenceInRepo.push(
        `${file.filePath}: ${file.source.slice(lineStart, lineEnd === -1 ? undefined : lineEnd).trim().slice(0, 200)}`,
      );
    }
  }

  return {
    function: {
      name,
      exported: isFunctionExported(parsed.program, fn, name),
      filePath: candidate.filePath,
      source: candidate.source,
    },
    machinery,
    invalidationPolicy: invalidationMatch?.[0] ?? null,
    wrappedLooksCheap,
    perfEvidenceInRepo,
    callers: findFunctionCallers(candidate.filePath, name, projectFiles),
  };
}
