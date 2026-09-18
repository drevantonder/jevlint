# Perf: pairwise-rule comparison-set design + prototype

Branch: `bb/174-perf-pairwise-rules-fresh-thr_9zm2p55ytf` (rebased onto `532087f`,
which contains evidence-memoization packet I `dbf87f9`).

## 1. Rule list

Pairwise-comparison rules = fingerprint-then-compare-all across context files,
once per review candidate. Exactly three:

| rule | per-candidate behavior |
|---|---|
| `jev/no-duplicated-logic` | fingerprints every function in every context file (2 whole-program visitors + O(file) offset rescan per function), qualifies by shared literals / shared members / identical opcode sequence, then runs one whole-project caller scan **per qualifying match** |
| `jev/no-coincidental-similarity` | same enumeration shape, heavier per-match divergence record, same per-match caller scans; ranking mixes in a common-caller term |
| `jev/no-paraphrased-sibling-logic` | already restricts enumeration to import-related files (`relatedPaths`), but still re-parses every file per candidate to compute that set, fingerprints every same-signature function in scope, and scans callers per match |

Explicitly NOT in the family (measured, not assumed):

- `clone-and-tweak-sibling`: same-module only, one owner parse per candidate. Already bounded; precedent for the owner-first ordering below.
- `duplicated-style-object` (9.2 ms) and `duplicated-fixture-drift` (0 ms, abstains)
  on the 8-file/64-function calibration corpus where the big two cost ~3 s each.
  Same order of work in principle, negligible constant in practice.

## 2. Profile (deterministic corpus, fake evaluators only)

Calibration corpus: seeded generator (`mulberry32(0x9e3779b9)`), `F` files × `G`
functions plus a fixed cross-file paraphrase pair; candidates = all functions of
2–3 changed files + the pair. Evidence builders only — no Jev calls anywhere.

Pre-memo shape (proves the O(candidates × functions) blowup):

| scale | dup total | coinc total | dup avg/candidate |
|---|---|---|---|
| 8 files / 64 fns / 18 cands | 4.1 s | 4.0 s | 188 ms |
| 16 files / 128 fns / 26 cands | 17–19 s | 15–32 s | 563–783 ms |
| 24 files / 192 fns / 26 cands | 33–41 s | 33–45 s | ~1.4 s |

Per-candidate cost grows ~quadratically in file count (302 ms → 1144 ms →
2281 ms for 8 → 16 → 24 files in one run). Dominant terms per candidate:
one parse per file, then per function `functionName` (a whole-program visit for
anonymous functions) + `nestedFunctionRanges` (whole-program visit) +
`fingerprintOf` (whole-program visit) + two O(file-length) offset rescans,
plus one whole-project caller re-scan per qualifying match.

Memoization packet I (`dbf87f9`, `parseCached` LRU + memoized module graph)
removes the parse term: 24-file dup 41.3 s → 0.43 s (~96×). Everything below is
measured **on top of memo** (cold parse cache per scale, warm JIT), i.e. the
stacking delta, not pre-memo numbers.

## 3. Design (`src/evidence/pairwise-scope.ts` + per-rule rewiring)

No parse/fingerprint caching here — that lane belongs to packet I. This
prototype only shrinks the **set** of comparisons. Four levers:

1. **Owner-first ordering.** Scope files sort owner module → import neighbours
   (resolved from the already-parsed owner program, zero extra parses) →
   everything else in project order, truncated at `maxScopeFiles` (default 40,
   owner always kept). Same-module siblings carry the strongest duplication
   signal, so a bound scope keeps the comparisons most likely to matter.
2. **Cheap structural pre-pass.** Top-level statement opcodes are readable off
   each enumerated node with zero visitors — and they are exactly the opcode
   list the fingerprinters derive — so opcode overlap and exact-sequence
   detection are free. Only the top `maxFullComparisons` (default 400) ranked
   functions proceed to full fingerprinting; exact sequence matches always
   survive the cut. Rank scoring is rule-aligned: duplicated-logic weights
   opcode overlap plus shared name vocabulary (duplicates share vocabulary);
   coincidental-similarity uses opcode overlap only (`nameWeight = 0`).
   Rationale for the split: measurement showed a shared-vocabulary term
   actively demotes what coincidental-similarity seeks (divergent names),
   swapping 23/32 top-3 lookalike sets at the binding scale; opcode-only
   ranking preserves all of them (see §5).
3. **Deferred caller resolution.** Whole-project caller scans run only for
   ranked survivors (dup/paraphrased: top-5 after a caller-free sort —
   exactly identical; coincidental: caller-enriched re-rank over preliminary
   top-12, identical whenever qualifying comparisons fit the resolution
   budget of 12, which covers every recorded fixture).
4. **Single-pass line offsets.** Function positions come from a binary search
   over precomputed line starts instead of a file-prefix rescan per function
   (unit-tested equal on every offset of a `\r\n`-mixed source).

Exactness contract: whenever the enumerated set fits the budgets, output is
bit-identical to unbounded scanning. A project-order tiebreaker
(`fileOrder`, `sequence`) reproduces unbounded scan order exactly, so ties do
not even reorder. Budgets default far above every recorded fixture
(40 files / 400 comparisons / 12 caller resolutions); the `exact` ablation
(open budgets, pre-pass off) is byte-identical to main at every measured
scale including the binding one, proving the exact levers never change
judgments.

## 4. Measured delta on top of memo

Quiet window (load ~1):

| scale | dup base → proto | coinc base → proto | paraphrased |
|---|---|---|---|
| 8f/64fn | 99.7 → 65.1 ms (1.5×) | 97.9 → 71.9 ms (1.4×) | 4.7 → 5.0 ms (~1×) |
| 16f/128fn | 281 → 194 ms (1.5×) | 293 → 183 ms (1.6×) | ~1× |
| 24f/192fn | 429 → 266 ms (1.6×) | 431 → 273 ms (1.6×) | ~1× |
| 48f/482fn (budgets bind) | 1635 → 725 ms (2.3×) | 1650 → 744 ms (2.2×) | ~1× |

Contended window (load ~8, sibling benches running; both arms back-to-back,
final run): dup 3.3× / 3.5× / 3.4× / 4.5×, coinc 3.6× / 3.5× / 3.3× / 2.1×,
paraphrased 3.0× / 1.9× / 2.4× / 1.0× across the 8/16/24/48-file scales.
The prototype holds its absolute times while the baseline degrades ~2× under
load (less work = less sensitivity to contention); ratios above are
same-window. (An earlier quiet window measured 1.4–2.3× on the heavy rules;
direction consistent, magnitude load-dependent.)

Attribution at the binding scale (dup, memo-baseline 1635 ms): exact levers
alone 983 ms (1.7× — deferred caller scans + offsets), file-scope bound 779 ms,
full prototype 725 ms. Paraphrased is already bounded by `relatedPaths`, so it
gains only the deferred caller scans (~1× at scale, up to ~2× on tiny inputs).

## 5. Recall spot-check

- Below the budgets: **byte-identical evidence** (raw JSON digest equality, not
  just normalized) for all three rules at the 8/16/24-file scales, plus the
  `exact` ablation byte-identical at the 48-file scale, plus targeted tests
  (`test/pairwise-scope.test.ts`: offset equivalence, ordering/truncation
  determinism, budget selection, pre-pass on/off identity on fixtures).
- Above the budgets (48 files / 482 functions; scope bound 40, comparison
  budget 400): duplicated-logic retains 101/110 reported matches (91.8%);
  all 8 diverged candidates keep an identical top-4 and swap only the 5th
  slot, and every swapped-out match sits in a file the 40-file scope excludes
  (index > 37) — i.e. the divergence is the file-scope bound working as
  designed, with same-module/related matches promoted into the freed slots.
  Coincidental-similarity and paraphrased-sibling-logic are byte-identical at
  this scale under default bounds (the scope bound keeps their sets small
  enough that the comparison budget never binds).
- Pre-pass isolation (no file bound): with rule-aligned scoring both rules
  preserve every reported match at the binding scale; the shared-vocabulary
  variant is kept for duplicated-logic only (see §3).

## 6. Rebase onto memo (`dbf87f9`) — conflicts

Two files conflicted on `git stash pop`, both mechanical: the memo packet had
converted `parseSync(path, source, { range: true })` → `parseCached(path,
source)` inside the exact loops this prototype rewrites
(`duplicated-logic.ts`, `coincidental-similarity.ts`). Resolved by keeping the
prototype structure and adopting `parseCached` at its enumeration parses
(including the ones the prototype adds) — stacking, not duplicating.
`paraphrased-sibling-logic.ts` merged cleanly. No semantic conflicts: memo
caches parses, this prototype shrinks comparison sets; the §4 numbers are the
composition of both. `JEVLINT_PARSE_CACHE=0` still bypasses the memo layer for
independent A/B work.

## 7. Merge recommendation

**Recommend merging** `pairwise-scope.ts` + the three rule rewirings + tests
after review, with two follow-ups noted (not in this change): `relatedPaths`
in paraphrased-sibling-logic still parses every file per candidate to compute
the related set (cheap today, unbounded in principle — same ordering helper
applies); the `maxCallerResolutions` preliminary re-rank for
coincidental-similarity is exact only while qualifying comparisons fit 12
(true on all fixtures and scales measured; a pathological hundreds-of-lookalikes
candidate would need the same file-scope-first treatment).
