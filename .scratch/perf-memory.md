# Perf memory: heap profile + reduction design (no merge)

Branch: `bb/175-perf-memory-fresh-thr_rqs75qenp5` (rebased onto main `532087f`,
includes evidence-memoization packet I `dbf87f9`). Zero live Jev calls — all
numbers from stub evaluators (constant probabilities) and dry-run-equivalent
loops. Lane closed with a **negative result**: prototype built and proved
judgment-preserving, then dropped uncommitted per coordinator (peak RSS flat,
final gates incomplete). This doc keeps the numbers.

## 1. Baselines (fixed samples, pinned file lists, stub evaluator)

Pre-memo (5-file sorted sample, dry-run): **86.5 s, 3628 MB peak RSS,
1921 MB post-GC heap** — the 6 GB self-run / 4 GB OOM symptom reproduced.

Post-memo main, pinned samples (lists exclude nothing on main; the pin only
matters for before/after comparability when the tree under test changes):

| Sample | Questions | Peak RSS | Post-GC heap |
|---|---|---|---|
| 5 files | 1244 | 254 MB | 74 MB |
| 12 files | 2756 | 349 MB | 156 MB |
| 25 files | 4882 | 519 MB | 293 MB |

Prototype (streaming audit + in-place compaction + synthetic cache bypass,
judgment-preservation proved by byte-identical canonical dumps of coverage,
judgments, abstentions, statistics on the pinned sample): peak RSS
253 / 347 / 523 MB; post-GC heap 70 / 144 / 293 MB. Retained heap −4 to
−14 MB; **peak flat**. Prototype dropped, not worth verifying.

## 2. Retention table (heap snapshots + settled within-process trials)

| Artifact | Per-pair cost | Note |
|---|---|---|
| Raw evidence objects | ~0 | strings are views into file sources |
| `structuredClone` in `compactEvidence` | ~7 KB/question in object shells | real but small |
| `evaluationCandidate` copies | ~0 | `replaceAll` no-match returns same ref (verified) |
| Whole-run `prepared[]` array | O(pairs), ~3 KB/item | streamed in prototype; secondary |
| **oxc-parser Visitor constructions** | **~0.25 KB/visit, permanent** | **the OOM driver (see §3)** |
| Synthetic one-shot parses in LRU | 680 dead entries per 12 files | bypass measured (cacheSize 692 → 56) but peak-neutral |

## 3. Finding: parser-boundary retention persists under memoization

Memoization eliminated re-parses but not visits, and the residue is per-visit,
not per-parse: 20k `new Visitor(...).visit(cachedProgram)` retains +4.7 MB.
An evidence loop retaining *nothing* still holds 99 → 180 → 345 MB heap
across 5/12/25-file samples — slope **~3.4 KB/pair**, surviving
`clearParseCache()` + dropping `projectFiles`. Snapshot census of the growth:
+419k plain `Object`, +124k `system/Context`, closures named after jevlint
visitor callbacks (`matches`, `addRange`, `CallExpression`, …) — binding-rooted,
undisposable from JS (oxc-parser already at latest 0.150.0).

Projection: full self-tree ≈ 2.8M pairs with per-pair visits scaling in file
count (repo-scanning builders) → residue alone is multi-GB. **The 4 GB default-
heap target is unreachable by retention work alone.** It needs visit-count
reduction (pairwise-rules lane) and/or an upstream oxc-parser report (the
20k-visitor repro above is minimal). Residual follow-ups for other owners:
parse-cache LRU cap (1000) is below the 1636-file tree — guaranteed churn at
full scale; judgment evidence stays O(questions) by report shape.

## 4. Recommendation: verify-or-close → close

Do not merge the prototype (dropped already: peak flat, final state never
fully gated — a late rewrite fixed a `hasTruncatedFlag` single-char-string
infinite loop found by inspection only). Stacking order for the 4 GB goal:
pairwise visit reduction first, then re-profile; streaming/disposal only
matters once residue stops dominating.
