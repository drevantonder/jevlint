# Open-source secrets audit (2026-09-18)

Scope: is this tree safe to publish to GitHub? Method is metadata-only —
lengths, hashes, presence, and counts. No live Jev calls, no secret values printed.

## Findings

| # | Area | Method | Verdict |
|---|------|--------|---------|
| 1 | Full-history token/key patterns (`sk-ant-`, `ghp_`, `AKIA`, `BEGIN PRIVATE KEY`, `api_key=…`, `bearer …`, `jev_…`, 383 revs) | `git grep -E` over `git rev-list --all` | CLEAN — only hits are fake fixture strings in `test/auth.test.ts` (`"shared-value"`, `"legacy-value"`, `"live-canary"`, canary `canary-jevlint-auth-…`); all predate this branch and are non-credential placeholders |
| 2 | Provider token headers in history (`AKIA…`, `ghp_…`, `xoxb-…`, `BEGIN…PRIVATE KEY`) | `git grep` over all revs | CLEAN — zero hits |
| 3 | High-entropy assigned strings in current tree (`='…40+ chars…'`) | repo-wide grep | CLEAN — 2 hits, both benign: a `NODE_TLS_REJECT_UNAUTHORIZED` source literal and the auth canary |
| 4 | `op://` references vs resolved values | history + tree grep; inspected `.env.schema` at add-commit | CLEAN — refs only (`op(op://van-tonder-nosudo/typesafe-api-key/credential)`); key lines were always empty or `op(…)`; no resolved values anywhere |
| 5 | Ever-committed key material (`.pem`, `.key`, `id_rsa`, `.env`, `credentials.json`, `.npmrc`) | `git log --name-only` filename scan | CLEAN — only `.env.schema` (since deleted; held refs only, see 4) |
| 6 | `TYPESAFE_API_KEY` literal values in history | `git log -p -S TYPESAFE_API_KEY`, filtered | CLEAN — docs, `export …='…'` placeholder in `docs/auth.md`, test fakes; no live values |
| 7 | Fixtures / live tests / docs for embedded secrets | pattern scan of `test/fixtures`, `test/live`, `src`, `tools`, `docs` | CLEAN — zero hits; live tests gated behind `RUN_LIVE_JEV=1` + `describe.skip`, so default `pnpm check` makes zero live calls |
| 8 | Token in `--out-dir` artifacts / `summary.json` | code trace (`src/out-dir.ts`, `src/types.ts` has no credential fields) + NEW canary test | CLEAN — artifacts serialize judgments/abstentions only; `apiKey` goes only to the SDK evaluator, never to disk; covered by `test/auth.test.ts` "keeps --out-dir artifacts and summary.json free of the key" (added this commit) |
| 9 | Token in cache | code trace (`src/cache.ts` digest material = format/repository/identity/state/question; identity has no key; cache dir is `.git/jevlint/cache/v1`, unpublished) | CLEAN — credential never enters digest or entries |
| 10 | Token in error texts / `--debug` / `--print-config` | trace of all `stderr` interpolations + existing canary tests | CLEAN — all messages static or file paths; `--print-config` emits `{ rules }` keys only; suite asserts `not.toContain(CANARY)` across flags |
| 11 | Tracked `.scratch` bench JSONs (15 files) | content sample + absolute-path count | CLEAN content — relative paths only (`src/analyze.ts`), digests, timings, node version, short git SHAs; zero `/home/…` hits. Note: they ship perf notes publicly; `.gitignore` now blocks future additions (this commit) but existing files stay tracked |
| 12 | `package.json` publish allowlist | `files: ["dist", "README.md"]` | CLEAN — publishes build output + readme only; no dotfiles, no scratch, no fixtures |
| 13 | LICENSE | tree + `package.json` + README search | **MISSING** — no `LICENSE` file, no `license` field, no README mention. No intended license stated anywhere. Publishing without one = all-rights-reserved by default. NOT changed (out of scope); coordinator must add before publish |
| 14 | `.gitignore` coverage | diff vs mission list | FIXED this commit — added `*.env` / `.env.*` (was exact `.env` only), `.scratch/perf-bench/results/`, `.scratch/bench-*.json`; `dist/`, `credentials`, `*.log` already covered |

## Fixes in this commit (trivially safe only)

- `.gitignore`: `*.env`, `.env.*`, `.scratch/perf-bench/results/`, `.scratch/bench-*.json`
- `test/auth.test.ts`: new `--out-dir` token-leak canary (closes the one untested exfil path)
- This report

## Verdict: ship-with-notes

Secrets posture is clean — no live secret in history, no exfil path carries the
token, canary suite (24 tests) green. Two notes before `Publish`:

1. **Add a `LICENSE` file + `license` field** (no intended license found anywhere; do not publish unlicensed).
2. Optional: `git rm --cached` the 15 tracked `.scratch` files (content verified benign) or accept shipping perf notes.
