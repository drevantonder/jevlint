---
name: jevlint
description: Probabilistic code review for JS/TS. Use when reviewing changed code (jevlint review) or surveying a codebase (jevlint audit), interpreting jevlint scores, or choosing jevlint flags. Scores are probabilities, never pass/fail.
---

# jevlint

Oxc discovers review candidates and builds rule-specific repository evidence; Jev scores one uncertain proposition per candidate/rule pair as a probability from 0 to 1. Vocabulary: **candidate** (a changed span eligible for rules), **judgment** (one scored proposition with span and evidence), **review report** (judgments plus abstention and failure summaries), **structural abstention** (rule skipped, evidence absent, no probability), **evaluation failure** (no valid answer, no probability, run incomplete). Say *judgment* and *review report*, never *diagnostic*, *lint error*, *violation*, or *pass/fail*.

## Run it

One copy-pasteable line (key is loaded from 1Password via Varlock; never copy the key itself):

```sh
pnpm jevlint review
```

## review vs audit in one breath

`review` scores changed code only — the working-tree or staged diff against `HEAD`, plus untracked source files; on a clean tree there is nothing changed, so there is nothing to score. `audit` surveys the whole codebase without needing a diff and runs to completion by default (every candidate/rule pair is prepared unless you opt into a limit). Both report probabilities only.

## Flag cheat-sheet

All flags verified against `src/cli.ts` on main. Bare `jevlint` with no subcommand, and any `--rules` flag, are owned by packet E — re-verify after 168 lands before asserting behavior.

```sh
pnpm jevlint review src/checkout          # PATH scope: files or dirs, either command
pnpm jevlint review --staged              # review only: staged changes
pnpm jevlint audit --max-questions 2000   # audit only: stop preparing after n questions
pnpm jevlint audit --evidence-budget-ms 60000  # audit only: wall-clock guard on preparation
pnpm jevlint audit --max-questions 2000 --dry-run  # audit only: count questions, zero Jev calls
pnpm jevlint review --format json         # text (default) or json
pnpm jevlint review --debug=files         # scope list to stderr, exit before evaluating
pnpm jevlint review --debug=timings       # per-rule timing table to stderr after report
pnpm jevlint review --debug=cache         # cache statistics to stderr
pnpm jevlint review --print-config        # effective config JSON, exit before evaluating
pnpm jevlint review --no-cache            # bypass the Jev response cache
pnpm jevlint review --refresh-cache       # re-evaluate, replace matching entries
pnpm jevlint review --min-score 0.5 --limit 10   # display filters, text only
pnpm jevlint review --config ./jevlint.config.ts # explicit config file
pnpm jevlint review --no-error-on-unmatched-pattern  # empty scope exits 0, not 2
```

Notes: `--staged` is rejected by `audit`; `--max-questions`, `--evidence-budget-ms`, and `--dry-run` are rejected by `review`. `--no-cache` and `--refresh-cache` are mutually exclusive. `--debug` modes are comma-separated and composable. Rule selection lives in the config file (`rules: { "jev/<id>": "off" }`); there is no CLI rule filter on main. A scope matching nothing is exit 2 unless `--no-error-on-unmatched-pattern` is given. Omitted audit pairs are deterministic priority order, never sampled, never cut by score; change-scope rules are never scored by audit (listed under `coverage.unscoredRules`).

## Output shapes

- `--format text` (default): judgments ranked by descending probability, top 5 shown (`--limit` default 5, may be raised, lowered, or 0), summary line `N evaluated; M displayed; A structurally abstained; F failed`, plus a hint line when judgments are hidden. `--min-score` filters before `--limit`.
- `--format json`: every completed judgment in `judgments`, full `coverage` object on audits, echoed display options; text and JSON summaries are identical.
- Stdout carries only the report or config JSON. Everything else — failure summaries, `--debug` output, `--debug=files` scope list — goes to stderr. Exit 0 means a completed review regardless of scores; exit 2 means invalid arguments, config/Git/API failure, or at least one evaluation failure (completed judgments are still reported).

## Contract

Probabilities in, no thresholds, cutoffs, severities, bands, or pass/fail out (see `docs/adr/0001-report-probabilities-without-pass-fail.md`). Consumers interpret; jevlint never decides. Structural abstentions are counts, never zero scores.
