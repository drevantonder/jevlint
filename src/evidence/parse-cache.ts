import { parseSync } from "oxc-parser";

export type CachedParseResult = ReturnType<typeof parseSync>;

interface CacheEntry {
  filePath: string;
  source: string;
  key: string;
  result: CachedParseResult;
}

// Default ceiling: whole-tree audits revisit the same files thousands of
// times, and a 309-file tree fits comfortably. Each entry pins one parsed
// program, so the cap bounds retained native AST memory.
const DEFAULT_ENTRY_LIMIT = 1000;

let entryLimit = DEFAULT_ENTRY_LIMIT;
const byKey = new Map<string, CacheEntry>();
const byPath = new Map<string, CacheEntry>();

export function setParseCacheLimit(next: number): void {
  entryLimit = Math.max(1, Math.floor(next));
  evict();
}

export function parseCacheLimit(): number {
  return entryLimit;
}

export function parseCacheSize(): number {
  return byKey.size;
}

export function clearParseCache(): void {
  byKey.clear();
  byPath.clear();
}

// cyrb53: non-cryptographic 53-bit hash. Collisions are theoretically
// possible but practically negligible for cache correctness (a collision
// would serve one file's AST for another); the length prefix in the key
// adds a cheap second discriminator.
export function hashSource(source: string): string {
  let high = 0xdeadbeef ^ source.length;
  let low = 0x41c6ce57 ^ source.length;
  for (let index = 0; index < source.length; index += 1) {
    const code = source.charCodeAt(index);
    high = Math.imul(high ^ code, 2654435761);
    low = Math.imul(low ^ code, 1597334677);
  }
  high = Math.imul(high ^ (high >>> 16), 2246822507) ^ Math.imul(low ^ (low >>> 13), 3266489909);
  low = Math.imul(low ^ (low >>> 16), 2246822507) ^ Math.imul(high ^ (high >>> 13), 3266489909);
  return `${(high >>> 0).toString(36)}${(low >>> 0).toString(36)}`;
}

function keyOf(filePath: string, source: string): string {
  return `${filePath}${source.length}${hashSource(source)}`;
}

function touch(entry: CacheEntry): void {
  // SAFETY: Map iterates in insertion order; re-inserting marks the entry
  // most-recently-used for LRU eviction. Shared references are safe:
  // evidence builders only read program/comments/errors.
  byKey.delete(entry.key);
  byKey.set(entry.key, entry);
  byPath.set(entry.filePath, entry);
}

function evict(): void {
  while (byKey.size > entryLimit) {
    const oldest = byKey.keys().next();
    if (oldest.done) return;
    const entry = byKey.get(oldest.value);
    byKey.delete(oldest.value);
    if (entry && byPath.get(entry.filePath) === entry) byPath.delete(entry.filePath);
  }
}

// Drop-in replacement for `parseSync(filePath, source, { range: true })`.
// Every evidence builder parses with identical options, so one cache serves
// all call sites. Returns the shared result object: callers must not mutate
// it (no current caller does; vitest + tsc + oxlint gates verify this).
// Escape hatch for A/B measurement and fault isolation:
// JEVLINT_PARSE_CACHE=0 bypasses the cache (plain parseSync per call).
export function parseCached(filePath: string, source: string): CachedParseResult {
  if (process.env["JEVLINT_PARSE_CACHE"] === "0") {
    return parseSync(filePath, source, { range: true });
  }
  const fast = byPath.get(filePath);
  if (fast !== undefined && fast.source === source) {
    touch(fast);
    return fast.result;
  }
  const key = keyOf(filePath, source);
  const hit = byKey.get(key);
  if (hit !== undefined) {
    touch(hit);
    return hit.result;
  }
  const result = parseSync(filePath, source, { range: true });
  const entry: CacheEntry = { filePath, source, key, result };
  byKey.set(key, entry);
  byPath.set(filePath, entry);
  evict();
  return result;
}
