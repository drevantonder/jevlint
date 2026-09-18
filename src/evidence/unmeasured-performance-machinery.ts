import { Visitor } from "oxc-parser";
import { parseCached } from "./parse-cache.js";
import type { CallExpression, Expression } from "oxc-parser";
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

export type PerfMachineryLifetime = "per-run" | "persistent" | "unknown";

export type PerfMachineryMotive = {
  /** Whether the retained state outlives one invocation. Per-run stores
   * created inside the function and discarded on return are accumulators,
   * not caches. Batching and pooling shape throughput rather than
   * retaining results, so their lifetime is unknown. */
  lifetime: PerfMachineryLifetime;
  lifetimeDetail: string | null;
  /** Names the mechanism that makes staleness impossible by construction
   * (content-hash key, immutable-input key, append-only writes), or null
   * when entries could go stale. */
  stalenessImpossible: string | null;
  /** Names the provider or API limit the batching or pooling answers
   * (a named size constant or a limit mention in the candidate), or null
   * when the shape looks latency-motivated rather than limit-fitting. */
  limitFit: string | null;
};

export type PerfMachinery = {
  expression: string;
  kind: PerfMachineryKind;
  line: number;
  motive: PerfMachineryMotive;
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
const BATCH_PATTERN = /batch|debounce|throttle|queueMicrotask|dataloader|\bchunk\b/i;
const POOL_PATTERN = /pool|Pool|pLimit|p-limit|concurrency/i;
const INVALIDATION_PATTERN = /ttl|maxAge|staleTime|gcTime|expires|evict|invalidate|maxEntries|maxSize|clear\(\)/i;
const PERF_REFERENCE_PATTERN = /benchmark|bench\.|profiling|flamegraph|lighthouse|clinic\.js|hotspot|perf test/i;
const HASH_KEY_PATTERN = /createHash|\.digest\(|sha-?256|sha-?1\b|md5|\bhash\(|fingerprint/i;
const FULL_CONTENT_KEY_PATTERN = /JSON\.stringify\(/;
const NAMED_LIMIT_PATTERN = /MAX|LIMIT|BATCH|CHUNK|PAGE|SIZE|TOKENS|QUOTA|CONCURRENCY|RATE/i;
const PROVIDER_LIMIT_PATTERN = /(provider|api|openai|anthropic|dynamodb|postgres|s3|stripe)\W{0,60}(limit|max|quota|page size|batch size)|maxTokens|context window|rate limit/i;
const DELETE_PATH_PATTERN = /\.delete\(|\.clear\(/;
const MEMBER_STORE_PATTERN = /\bthis\.\w+\s*=\s*new\s+(Map|WeakMap|LRUCache|Cache|TTLCache|Pool)/;

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

function expressionText(node: { start: number; end: number }, source: string): string {
  return source.slice(node.start, node.end);
}

export function buildUnmeasuredPerformanceMachineryEvidence(
  candidate: Candidate,
  projectFiles: ProjectFile[],
): UnmeasuredPerformanceMachineryEvidence | undefined {
  if (candidate.kind !== "function") return undefined;
  const owner = projectFiles.find((file) => file.filePath === candidate.filePath);
  if (!owner) return undefined;
  const parsed = parseCached(owner.filePath, owner.source);
  if (parsed.errors.some((error) => error.severity === "Error")) return undefined;
  const fn = findDirectFunction(parsed.program, candidate);
  if (!fn) return undefined;
  const name = functionName(parsed.program, fn);
  if (!name) return undefined;

  const nested = nestedFunctionRanges(parsed.program, candidate);
  const inScope = (start: number, end: number): boolean =>
    start >= candidate.start && end <= candidate.end
    && !nested.some((range) => range.start <= start && range.end >= end);

  // Pre-pass: where do store holders and key bindings come from?
  const localStores = new Set<string>();
  const newStoreNames = new Map<number, string>();
  const outerStores = new Set<string>();
  const hashDerived = new Map<string, string>();
  new Visitor({
    VariableDeclarator(node) {
      if (node.id.type !== "Identifier" || !node.init) return;
      const initText = expressionText(node.init, owner.source);
      if (
        node.init.type === "NewExpression"
        && CACHE_STORE_PATTERN.test(expressionText(node.init.callee, owner.source))
      ) {
        if (inScope(node.start, node.end)) {
          localStores.add(node.id.name);
          newStoreNames.set(node.init.start, node.id.name);
        } else outerStores.add(node.id.name);
        return;
      }
      if (HASH_KEY_PATTERN.test(initText)) {
        hashDerived.set(node.id.name, initText.slice(0, 120));
      }
    },
  }).visit(parsed.program);

  const candidateText = owner.source.slice(candidate.start, candidate.end);
  const hasDeletePath = DELETE_PATH_PATTERN.test(candidateText);
  const providerLimitMatch = PROVIDER_LIMIT_PATTERN.exec(candidateText);
  const memberStoreMatch = MEMBER_STORE_PATTERN.test(candidateText);

  const keyIsContentDerived = (keyText: string): string | null => {
    if (HASH_KEY_PATTERN.test(keyText)) return `content-hash key '${keyText.slice(0, 80)}'`;
    if (FULL_CONTENT_KEY_PATTERN.test(keyText)) {
      return `immutable-input key '${keyText.slice(0, 80)}' carries the full input`;
    }
    return null;
  };

  const stalenessForKey = (keyText: string | undefined): string | null => {
    if (!keyText) return null;
    const trimmed = keyText.trim();
    let mechanism = keyIsContentDerived(trimmed);
    if (!mechanism) {
      const binding = hashDerived.get(trimmed);
      if (binding !== undefined) mechanism = `content-hash key '${trimmed}' derives from '${binding}'`;
    }
    if (!mechanism) return null;
    if (!hasDeletePath) mechanism += `; append-only writes (no delete/clear in '${name}')`;
    return mechanism;
  };

  const motiveFor = (
    kind: PerfMachineryKind,
    holder: string | undefined,
    callArguments: Expression[] | undefined,
  ): PerfMachineryMotive => {
    let lifetime: PerfMachineryLifetime = "unknown";
    let lifetimeDetail: string | null = null;
    if (kind === "cache-store") {
      if (holder !== undefined && localStores.has(holder)) {
        lifetime = "per-run";
        lifetimeDetail = `'${holder}' is created inside '${name}' and discarded on return`;
      } else if (holder !== undefined) {
        lifetime = "persistent";
        lifetimeDetail = outerStores.has(holder)
          ? `'${holder}' is declared outside '${name}' and shared across invocations`
          : `'${holder}' is not created inside '${name}'; entries are shared across invocations`;
      } else {
        lifetime = memberStoreMatch ? "persistent" : "per-run";
        lifetimeDetail = memberStoreMatch
          ? `store is kept on 'this' and outlives the '${name}' call`
          : `store is constructed inside '${name}' on each invocation`;
      }
    } else if (kind === "memoize-call") {
      lifetime = "persistent";
      lifetimeDetail = `memoized function retains entries across '${name}' calls`;
    } else if (kind === "memo-hook") {
      lifetimeDetail = "memo-hook lifetime follows the component instance";
    } else if (kind === "memo-component" || kind === "custom-comparator") {
      lifetimeDetail = "memoized-component lifetime follows the component type";
    } else {
      lifetimeDetail = "batching/pooling shapes throughput rather than retaining results";
    }

    let stalenessImpossible: string | null = null;
    if (kind === "cache-store" && callArguments && callArguments.length > 0) {
      const first = callArguments[0];
      if (first) stalenessImpossible = stalenessForKey(expressionText(first, owner.source));
    }

    let limitFit: string | null = null;
    if ((kind === "batch-layer" || kind === "pool-layer") && callArguments) {
      const named = callArguments.find((argument) =>
        argument.type === "Identifier" ? NAMED_LIMIT_PATTERN.test(argument.name) : false
      );
      if (named && named.type === "Identifier") {
        limitFit = `size follows named limit '${named.name}'`;
      } else if (providerLimitMatch) {
        limitFit = `shaped by '${providerLimitMatch[0].slice(0, 80)}'`;
      }
    }

    return { lifetime, lifetimeDetail, stalenessImpossible, limitFit };
  };

  const machinery: PerfMachinery[] = [];
  const seen = new Set<string>();

  const push = (
    node: { start: number; end: number },
    kind: PerfMachineryKind,
    holder?: string,
    callArguments?: Expression[],
  ): void => {
    const key = `${kind}:${node.start}`;
    if (seen.has(key)) return;
    seen.add(key);
    machinery.push({
      expression: owner.source.slice(node.start, node.end).slice(0, 300),
      kind,
      line: lineAt(owner.source, node.start),
      motive: motiveFor(kind, holder, callArguments),
    });
  };

  const callArgumentsOf = (call: CallExpression): Expression[] =>
    call.arguments.filter((argument): argument is Expression => argument.type !== "SpreadElement");

  new Visitor({
    CallExpression(call) {
      if (!inScope(call.start, call.end)) return;
      const text = calleeText(call.callee, owner.source);
      const root = calleeRoot(call.callee);
      if (root && MEMO_HOOK_PATTERN.test(root)) {
        push(call, "memo-hook", root, callArgumentsOf(call));
        return;
      }
      if (MEMO_COMPONENT_PATTERN.test(text)) {
        const second = call.arguments[1];
        push(call, second ? "custom-comparator" : "memo-component");
        return;
      }
      if (root && MEMOIZE_CALL_PATTERN.test(root)) {
        push(call, "memoize-call", root);
        return;
      }
      if (root && CACHE_STORE_PATTERN.test(root) && call.callee.type === "NewExpression") {
        push(call, "cache-store", undefined, undefined);
        return;
      }
      if (
        call.callee.type === "MemberExpression"
        && call.callee.property.type === "Identifier"
        && CACHE_METHOD_PATTERN.test(call.callee.property.name)
        && (CACHE_STORE_PATTERN.test(root ?? "") || CACHE_HOLDER_PATTERN.test(root ?? ""))
      ) {
        const keyArgument = call.arguments[0];
        push(
          call,
          "cache-store",
          root,
          keyArgument !== undefined && keyArgument.type !== "SpreadElement"
            ? [keyArgument]
            : undefined,
        );
        return;
      }
      if (BATCH_PATTERN.test(text) || (root && BATCH_PATTERN.test(root))) {
        push(call, "batch-layer", root, callArgumentsOf(call));
        return;
      }
      if (POOL_PATTERN.test(text) || (root && POOL_PATTERN.test(root))) {
        push(call, "pool-layer", root, callArgumentsOf(call));
      }
    },
    NewExpression(node) {
      if (!inScope(node.start, node.end)) return;
      const text = owner.source.slice(node.callee.start, node.callee.end);
      if (CACHE_STORE_PATTERN.test(text) || POOL_PATTERN.test(text)) {
        push(
          node,
          CACHE_STORE_PATTERN.test(text) ? "cache-store" : "pool-layer",
          CACHE_STORE_PATTERN.test(text) ? newStoreNames.get(node.start) : undefined,
        );
      }
    },
  }).visit(parsed.program);

  if (machinery.length === 0) return undefined;

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
