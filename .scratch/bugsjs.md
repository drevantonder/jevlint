# BugsJS front + Multi-SWE-bench assessment

## BugsJS framework

- Framework clone: `/tmp/opencode/bugsjs` (`main.py` + `myGit.py`/`myTask.py`/…).
- Checkout flow: `python main.py --task checkout --project <Name> --bug-ID <N> --version
  <buggy|fixed|fixed-only-test-change> --output <dir>`.
  `myGit.checkout` clones the project repo and checks out `tags/Bug-<N>^`
  (buggy parent), `tags/Bug-<N>-full` (fixed), or `tags/Bug-<N>-test`.
- Tag anatomy per bug (verified on Express): `Bug-N` = buggy commit,
  `Bug-N-fix` = buggy + source fix only, `Bug-N-test` = buggy + test only,
  `Bug-N-full` = buggy + fix + test. Source fix = `git diff Bug-N Bug-N-fix`
  (no test files by construction).
- Project mirrors (full clones, same machine): `work/express` (27 bugs),
  `work/mongoose` (29 bugs, ~69M).

## Inverted construction (verified on pilot)

`HEAD = Bug-N-full`, worktree = `git diff Bug-N Bug-N-fix` applied with
`git apply -R` (uncommitted). The diff under review therefore *introduces* the
buggy lines; a hit = judgment whose file + line span covers a reintroduced
buggy (+) line. Reversed hunks applied cleanly in all 3 pilot cases and every
touched `.js` file passed `node --check`.

Harness: `/tmp/opencode/bugsjs/run-bug.sh <work-repo> <bug-id> <case>` writes
`cases/<case>/`, `reports/<case>.json`, `logs/<case>.diff/.fix.patch/.setup.log/.stderr.log`.
Scorer: `/tmp/opencode/bugsjs/score.py <case>...` (overlap = span covers ≥1
buggy added line; raw distributions only).

## Pilot results (3 bugs, 2 projects)

| case | bug | buggy lines | evaluated / abstained / failed | questions / live req | max score | top overlapping |
|---|---|---|---|---|---|---|
| exp-1 | Express-1: dup methods in OPTIONS Allow header (`options.push.apply` reintroduced, line 210) | 1 | 31 / 336 / 0 | 31 / 4 | 0.41 | 0.41 `no-breaking-export-reshape` 210-210 (exact line); 0.41 `no-mirrored-derived-state` 167-241; 0.34 `no-mysterious-name` 122-274 |
| exp-2 | Express-2: trust-proxy arity (`trust(addr, 0)` reintroduced, line 361) | 1 | 8 / 117 / 0 | 8 / 2 | 0.27 | 0.27 `no-repeated-handler-preamble` 355-369; 0.26 `no-feature-envy`; 0.09 `no-complexity-displacement` 361-361 (exact line) |
| mon-1 | Mongoose-1: versionKey/versioning handling (schema.js 84-87 + model.js block removal) | 4 | 25 / 108 / 0 | 25 / 3 | 0.49 | 0.49 `no-hidden-input-mutation` 50-87 (covers 84-87); 0.24 `no-speculative-generality`; exact-line 0.14 `no-narrating-comment` 85/86 |

Hit/miss per bug (overlap = any judgment covering a buggy line): **3/3 overlap**,
each with at least one tight (≤15-line or exact-line) overlapping judgment.
Caveat: broad function-span judgments overlap single-line bugs trivially, so
"any overlap" flatters; the tight-overlap rows above carry the signal.

Spend totals (pilot): 64 questions, 9 live requests, 0 cache hits (cold),
0 failures. Per-bug average ≈ 21 questions — far under the ~150 guide.

## 30-bug scale

Verdict: **SCALE** (cost sane; no bug exploded — max 31 questions on pilot).
Scale run: Express 3-27 + Mongoose 2-3 (27 cases) via `run-bug.sh` loop,
background shell `sh_0b0c55176001aPb5BwPJchDVRu`, log `logs/scale.log`.
Completed 2026-09-17: all 27 scale cases EXIT=0, reversed hunks applied cleanly,
all touched files `node --check` OK.

Result: **29/30 cases have ≥1 judgment overlapping the reintroduced buggy lines.**
Totals: 467 questions, 79 live requests (avg 15.6 q/bug, max 45 on exp-10) —
no bug exploded; cold cache throughout, 0 evaluation failures.
Best-overlapping score per case ranges 0.23–0.78 (raw values, no cutoff implied).

The single non-overlap, exp-14, is structural, not a miss: its fix is purely
additive (null-guard in `lib/router/layer.js`), so the reversed diff is a pure
deletion with 0 added lines and jevlint reports evaluated=0 — deletion-only
reintroductions yield no candidates under this construction.

Per-case (buggy added lines / evaluated / live req / overlapping / best overlap):
exp-3 1/7/2/7/0.23, exp-4 1/5/2/5/0.27, exp-5 1/7/2/7/0.25,
exp-6 7/14/2/14/0.56, exp-7 2/17/4/17/0.54, exp-8 1/16/3/16/0.47,
exp-9 1/14/3/14/0.44, exp-10 5/45/6/45/0.62, exp-11 6/10/2/10/0.75,
exp-12 12/15/2/15/0.29, exp-13 7/34/4/34/0.43, exp-14 0/0/0/0/n-a (pure deletion),
exp-15 1/7/2/7/0.24, exp-16 2/18/3/18/0.49, exp-17 1/16/2/16/0.38,
exp-18 1/19/3/19/0.29, exp-19 4/13/2/13/0.49, exp-20 3/18/3/18/0.55,
exp-21 13/21/3/21/0.78, exp-22 1/7/2/7/0.24, exp-23 2/13/2/13/0.41,
exp-24 3/15/2/15/0.40, exp-25 2/10/2/10/0.55, exp-26 1/8/2/8/0.29,
exp-27 2/20/3/20/0.29, mon-2 5/20/4/20/0.57, mon-3 3/14/3/14/0.46.

## Multi-SWE-bench JS/TS assessment (assess only, not run)

- **Location**: dataset `ByteDance-Seed/Multi-SWE-bench` (HF, public, ungated;
  `huggingface.co/datasets/ByteDance-Seed/Multi-SWE-bench`), harness
  `github.com/multi-swe-bench/multi-swe-bench` (Apache-2.0).
- **JS/TS instance count (counted 2026-09-17 by line-counting the dataset JSONLs)**:
  580 total = JS 356 (svelte 272, dayjs 56, github-readme-stats 19, axios 4,
  express 4, insomnia 1) + TS 224 (material-ui 174, vuejs/core 48, darkreader 2).
  Heavily skewed: svelte + material-ui = 446/580 (77%).
- **Access method**: per-repo `<org>__<repo>_dataset.jsonl` files under `js/`/`ts/`;
  instance schema: `{org, repo, number, title, body, base, fix_patch, test_patch,
  fixed_tests, f2p_tests, p2p_tests, hints, ...}`. Sparse git clone of just
  `js/`+`ts/` is cheap (KBs of JSONL).
- **Estimated per-instance setup cost**: one Docker image build per repo base
  (amortized; `node:18`/`node:20` bases, repo cloned or COPYed in, `pnpm@9`),
  then per instance: checkout `base` commit + apply test patch + dependency
  install. Install dominates: mui/material-ui and svelte monorepos need a full
  pnpm/npm install (minutes, GBs) per fresh container unless the image layer is
  reused. jevlint-side cost per instance should mirror the BugsJS pilot
  (~10-60 questions cold) since patch sizes are comparable (mui sample:
  fix 3.3K, test 1.5K).
- **Can its container host a jevlint run? Yes, with two modifications.**
  (1) Node version: images pin node 18/20, jevlint requires node ≥22 — add a
  node-upgrade step or COPY a prebuilt jevlint `dist/` + node 22 binary.
  (2) Secrets/network: jevlint needs Jev API egress plus the 1Password service
  token; the harness already clones from github at build (network present) and
  supports `global_env` passthrough, so inject `OP_SERVICE_ACCOUNT_TOKEN` via
  `global_env` and run the same inverted construction inside the container
  (`HEAD` = fixed commit, worktree = reversed `fix_patch` filtered to
  non-test files). No harness fork needed — a `fix_patch_run_cmd` override or a
  post-checkout exec step suffices.
- **Suggested slice if pursued**: svelte (272, JS) + material-ui (174, TS) cover
  77% of JS/TS instances with just two image builds; dayjs (56) is the cheap
  third.
