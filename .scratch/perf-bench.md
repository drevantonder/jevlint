# perf-bench: fixed-sample deterministic benchmark

`tools/perf-bench.mjs` is the ruler the perf prototypes are measured against.
Fixed 9-file sample, three timed phases, peak RSS + heap, JSON results,
run-to-run comparison, and a suggested (unwired) regression-gate shape.

## Non-goals

- **Time only, never scores.** Per `docs/adr/0001-report-probabilities-without-pass-fail.md`
  jevlint reports probabilities without pass/fail; score/recall regressions are
  out of scope for this harness. The stub evaluator produces a checksum (proof
  of execution), never a judgment. `compare` shows count deltas as informational
  only; `gate` cannot see scores at all.
- **Not wired into `pnpm check`.** The `gate` subcommand exists so the
  coordinator can adopt it later; nothing in the harness touches `package.json`
  scripts or gates.

## Zero live Jev / zero network guarantee

- Imports only `dist/candidates.js`, `dist/defaults.js`, `dist/evidence/index.js`.
  Never the TypeSafe SDK, never `typesafe-evaluator.js`, never the cache path.
- Run as plain `node tools/perf-bench.mjs` — NOT via varlock / `pnpm jevlint`.
  No secret loading, no env-key reads (the sole env var consulted is
  `JEVLINT_PARSE_CACHE`, the memo kill-switch, recorded in the JSON).
- The evidence phase is the same preparation `audit --dry-run` performs
  (`buildRuleEvidence` per in-scope candidate/rule pair); the scoring-stub
  phase mirrors the evaluate plumbing in fixed batches of 24
  (`MAX_QUESTIONS_PER_REQUEST`) with deterministic content-derived
  pseudo-values.

## Sample (pinned by `sample.hash`)

| File | Role |
|------|------|
| `src/analyze.ts` | pipeline core, largest hand-written module |
| `src/cache.ts` | Jev response cache path |
| `src/candidates.ts` | Oxc candidacy path |
| `src/cli.ts` | CLI/audit orchestration, large |
| `src/config.ts` | small config module |
| `src/evidence/module.ts` | graph-heavy evidence provider |
| `src/evidence/state-model.ts` | state-heavy evidence provider |
| `src/format.ts` | report formatting |
| `src/git.ts` | repository file collection |

Deliberate exclusions: `src/defaults.ts` (555KB data table, zero candidates —
parse cost with no pairs, i.e. noise) and generated glue
(`src/evidence/index.ts`). `--files` overrides the sample for ad-hoc probing
but flags the run non-comparable (`sample.override`, hash mismatch fails the gate).

Sample history: pre-memoization the two giants (`analyze.ts`, `cli.ts`) had to
be excluded — each evidence call retained heap at the oxc-parser parse+visit
boundary (~5KB/call baseline, ~1MB/call for three vocabulary-heavy rules:
`no-repeated-predicate`, `no-synonym-vocabulary`,
`no-fragmented-stateful-procedure`), OOMing a default 4GB heap. The
evidence-memoization prototype (`.scratch/perf-memo.md`) eliminated the
retention, so the giants are back in. If the sample ever changes again, the
hash makes the break explicit: cut a new baseline, keep the old file.

## Usage

```sh
pnpm build  # dist/ must be fresh; staleness is flagged, not fatal
node tools/perf-bench.mjs bench [--results-dir <dir>] [--tag <name>] [--files a,b,c] [--repeat <n>]
node tools/perf-bench.mjs compare --baseline <file> --current <file>
node tools/perf-bench.mjs gate --baseline <file> --current <file> \
  [--max-regression-pct 15] [--max-rss-growth-pct 25]
```

`bench` writes one JSON file to `--results-dir` (default
`.scratch/perf-bench/results/`) and prints a phase table, counts, RSS, and the
top-10 slowest evidence rules (per-rule aggregates live in the JSON as
`evidenceByRule`, sorted slowest-first — the pairwise-rules thread's
hit list). `JEVLINT_PARSE_CACHE=0` runs the A/B without the parse cache; the
mode is recorded (`parseCache: on|bypass`) and `compare` warns on mismatch.

Result JSON: `tool/version/tag/createdAt/nodeVersion/platform/heapLimitMB/
parseCache`, `git` (HEAD + `src/` dirtiness), `dist` (staleness flag),
`sample` (per-file bytes + sha12, hash), `counts`, `phases`
(`load/candidacy/evidence/scoringStub/total/wall` ms medians over `--repeat`
runs), `evidenceByRule`, `rss` (`peakMB/heapPeakMB/finalMB`), `stubChecksum`.

## Suggested gate shape (not wired)

`gate` fails (exit 1) when: sample hashes differ; any phase with a ≥50ms
baseline (the noise floor — sub-50ms phases are compare-only) regresses more
than `--max-regression-pct` (default 15); peak RSS or peak heap grows more
than `--max-rss-growth-pct` (default 25). Counts are never gated. Suggested
practice: `--repeat 3` for gate-quality numbers, one baseline per `main`
advance that touches `src/`.

## Sibling plug-in recipes

- **Evidence memoization (landed, baseline is post-memo):** nothing to do —
  the harness exercises the memoized path transparently. For A/B:
  `JEVLINT_PARSE_CACHE=0 node tools/perf-bench.mjs bench --tag nomemo`, then
  `compare` against the cached run (expect the cache-mode warning + large
  evidence delta, identical counts).
- **Pairwise-rule bounds:** rebuild, `bench --tag bounds`, `compare` vs
  baseline. Expect `pairs`/`prepared` to drop (informational) and
  `evidenceMs` + the `evidenceByRule` top rows (`coincidental-similarity`,
  `duplicated-logic`, `paraphrased-sibling-logic`, …) to fall.
- **Memory reduction:** rebuild, `bench --tag mem`, `compare` vs baseline.
  Expect `rss.peakMB` / `rss.heapPeakMB` to drop; time may stay flat. The
  pre-memo retention numbers above are the reference for "what used to blow up".

## Baselines (post-memo `main` = `532087f`)

Canonical sample `23bab296e31e`, 9 files, 305 candidates, 57,836 pairs
(3,235 prepared / 54,337 abstentions / 264 unhandled), 135 stub batches:

| Phase | Run 1 (`baseline`) | Run 2 (`baseline2`) | Δ |
|-------|-------------------|--------------------|---|
| load | 92.2 ms | 105.0 ms | noise (sub-gate) |
| candidacy | 18.2 ms | 20.7 ms | noise (sub-gate) |
| evidence | 42,723.1 ms | 43,135.8 ms | +1.0% |
| scoring-stub | 1.5 ms | 1.5 ms | +0.0% |
| total | 42,742.8 ms | 43,158.0 ms | +1.0% |
| peak RSS | 347.1 MB | 354.6 MB | +2.2% |
| peak heap | 203.0 MB | 220.4 MB | +8.6% |

Top evidence rules on baseline: `coincidental-similarity` ~7.5s,
`duplicated-logic` ~7.4s (248 calls each), then `shallow-convenience-layer`
~1.7s, `paraphrased-sibling-logic` ~1.4s, `scattered-policy` ~1.2s.
Regenerate any time in ~45s: `pnpm build && node tools/perf-bench.mjs bench --tag <name>`.
