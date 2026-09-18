# Perf memo: evidence memoization (profile + design + prototype delta)

Branch: `bb/173-perf-evidence-memo-fresh-thr_diis4etpzd`. Prototype commit: see spec-packet.
Zero live Jev calls — all numbers from stub evaluators, `--dry-run`-equivalent
(`dryRun: true`), and direct builder microbench. No merges, no push.

## 1. Profile: where per-pair time goes

Fixed sample: 5 `src/` files (`analyze, candidates, cli, config, evidence/module`),
300 rules, 205 candidates → **40,024 rule-candidate pairs** (baseline `dist/`).

| # | Measurement | Result |
|---|-------------|--------|
| P1 | All-pairs `buildRuleEvidence` loop, first 200 pairs | **8.02 ms/pair** (1605 ms / 200) |
| P2 | One function candidate × all 229 function-scope builders | **2017 ms** total |
| P3 | Slowest builders in P2 | `coincidental-similarity` **450 ms**, `duplicated-logic` **441 ms** (top-2 = 44% of P2; slowest quartile = 78%) |
| P4 | `parseSync(src/analyze.ts)` alone | **2.68 ms/parse** → 229 builders × re-parse ≈ 613 ms of P2 is pure re-parsing |
| P5 | `buildModuleGraph` (5 files) | **7.6 ms** — rebuilt inside *every* module-evidence builder call (~14 builders × module candidates) |
| P6 | Stub-evaluator audit, 2000 questions, 5 files | **185 s** (~92 ms/pair; module builders + GC pressure dominate at scale) |

**Classification (pair-specific vs file-specific vs repo-specific):**

- **File-specific, rebuilt per pair (pure waste):** owner-file `parseSync` in
  ~269 call sites (`parseSync(owner.filePath, owner.source, …)` × 187,
  `(file.filePath, file.source)` × 72, …). All use identical `{ range: true }`
  options; no caller mutates the AST (verified by grep + full suite).
- **Repo-specific, rebuilt per pair (pure waste):** `buildModuleGraph`
  (parses *every* file + `resolveModule` per edge) inside each
  `buildModuleEvidence` call; `findFunctionCallers` /
  `findModuleImporters` / `findRelatedProjectModules` in `repository.ts`
  re-parse **all** `projectFiles` per call — and the similarity builders call
  `findFunctionCallers` once per *lookalike match* on top of their own repo scan.
- **Genuinely pair-specific (must stay):** fingerprint/opcode comparison,
  slice/diff of the candidate span, evidence object assembly
  (`compactEvidence`, `structuredClone`), request batching in `analyze.ts`.

**Memory finding (the OOM driver, bigger than the time story):**

- 5-file / 40k-pair loop **OOMs at Node 4 GB default**; audit 2000q + dry-run
  follow-up in one process also OOMs.
- Controlled trials (`--expose-gc`, `global.gc()` + sleeps before measuring):
  - `parseSync` + drop, no visit: **~0.03 KB/call** (flat).
  - Visit the *same* program 200×: **flat**. Keep 200 nodes alive: **flat**.
  - `parseSync` fresh program + one `Visitor` walk + drop: **~5–10 KB retained/call**,
    linear and never collected (exact binding mechanism not bisected — observed
    at the `oxc-parser` parse+visit boundary, not in jevlint code: no module-level
    mutable state exists in the builders).
  - Consequence per builder call: trivial builders (e.g. `double-negation`)
    retain **~7.5 KB/call**; repo-scanning similarity builders retain
    **~715 KB/call** (they parse + visit every file per pair).
  - 200-pair loop: RSS **110 → 354 MB** (+244 MB) for 200 pairs.
- So the same fix that removes redundant parses also removes the retention:
  with one cached program per file, 4000 visits retain **~1.3 MB total** (noise).

## 2. Design: per-file parse cache + shared module graph

New: `src/evidence/parse-cache.ts`. Changed: all 269 `parseSync(` call sites →
`parseCached(`, `src/evidence/module.ts` (graph memo), `src/candidates.ts`
(cache warm-up for free), `tools/generate-registry.mjs` (allowlist),
`test/parse-cache.test.ts` (7 tests).

**Parse cache — keys, invalidation, ceiling:**

- Key = `filePath + source.length + cyrb53(source)` (path in key because
  `parseSync` behavior varies by extension; length prefix is a cheap second
  discriminator; 53-bit hash makes collisions negligible for cache use).
- Fast path: per-path slot with **reference equality** on the source string —
  within a run every builder passes the same `projectFiles` string objects, so
  hits cost O(1) pointer compares, zero hashing. Reference miss falls back to
  length+hash compare (one O(len) hash), then re-parse on mismatch.
- Invalidation: any content change under the same path → different key →
  re-parse. Nothing else to invalidate (parse is a pure function of path+source).
- Memory ceiling: **LRU, default 1000 entries** (whole 309-file tree fits;
  each entry pins one parsed program). `setParseCacheLimit` /
  `clearParseCache` exported for tests and fault isolation.
- Shared-result discipline: the cached result object is returned by reference;
  callers must not mutate (none do; tsc + 1589 vitest + oxlint verify).
- Known non-hits (bounded by LRU, no worse than before): synthetic per-pair
  sources (`variant-partitioned-helper` parses `"(…variant.ts", wrapped)"`
  with unique content per pair).
- Escape hatch: `JEVLINT_PARSE_CACHE=0` bypasses both caches (plain `parseSync`
  + uncached graph) for A/B measurement.

**Module-graph sharing — keys, invalidation, ceiling:**

- `buildModuleGraph` memoized in place (no signature changes; all 14+
  module-evidence builders and `analyze.ts` benefit transparently).
- Key: `WeakMap` on the `projectFiles` **array identity** + O(files) identity
  check of element refs and source-string refs. Zero content hashing; any new
  array, reorder, or replaced source string → miss → rebuild via
  `buildModuleGraphUncached`.
- Ceiling: one entry per live array; `WeakMap` lets dead runs GC freely —
  inherently bounded, no tuning knob needed.

**What was deliberately NOT changed:** builder logic, evidence shapes,
`analyze.ts` batching/budgets, candidate extraction, judgments. The codemod is
mechanical (same args, same return shape); `ReturnType<typeof parseSync>`
type refs became `ReturnType<typeof parseCached>` (identical type).

## 3. Measured delta (same fixed sample, stub evaluator, no live Jev)

| Benchmark | Before | After | Δ |
|-----------|--------|-------|---|
| M1: 200 pairs `buildRuleEvidence` | 1605 ms (8.02 ms/pair) | **498 ms (2.49 ms/pair)** | **3.2×** |
| M2: 1 candidate × 229 function builders | 2016.9 ms | **456 ms** | **4.4×** |
| M3: `buildModuleGraph` × 20 | ~152 ms | **0.3 ms** | **~500×** |
| M4: audit, stub evaluator, 500 questions | 47.0 s (~94 ms/pair) | **7.4 s (~15 ms/pair)** | **6.4×** |
| M5: audit, stub evaluator, 2000 questions | 185 s | **36.9 s** | **5.0×** |
| Memory: 200-pair loop RSS | 110 → 354 MB | heap flat ~40 MB; full runs complete, **no OOM** | retention eliminated |

**Judgment preservation (same tree, cache on vs off, 500 stub questions):**
judgments **byte-identical**, abstentions **byte-identical**, stats identical
(79 requests / 500 questions both). Plus full gates green:
`tsc --noEmit` ✓, `generate-registry --check` ✓, **1589 vitest passed** ✓,
`oxlint` clean ✓.

## 4. Limits & follow-ups (for sibling threads / coordinator)

- Remaining per-pair cost (~15 ms on the 5-file repo, scaling with repo size)
  is now dominated by genuinely pair-specific work (fingerprint-vs-repo loops
  in the similarity builders, evidence assembly). Further wins need algorithmic
  changes there (e.g. precomputed per-file fingerprints — a natural phase 2 on
  top of this cache), owned by the pairwise-rules thread.
- `analyze.ts` still calls `buildRuleEvidence` per pair (now cheap lookups);
  batching/budgets untouched.
- Suggested default: ship the cache **always-on** (it is transparent and
  judgment-preserving); keep `JEVLINT_PARSE_CACHE=0` as the documented kill
  switch. LRU limit 1000 covers this repo; revisit only for >1k-file trees.
- The oxc-parser parse+visit retention (~5–10 KB per fresh program) deserves an
  upstream report with a minimal repro (bench11 pattern); the cache sidesteps
  it for jevlint regardless.
