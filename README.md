# jevlint

A diff-aware probabilistic code review tool for JavaScript and TypeScript. Oxc discovers candidates and builds rule-specific repository evidence. [Jev](https://docs.typesafe.ai/introduction) makes narrow semantic judgments and returns probabilities. Jevlint reports every judgment with its evidence and does not decide pass or fail.

Run it with `pnpm jevlint` (run `pnpm build` first). With no subcommand it audits the full tree.

## Status

This first slice supports:

- JavaScript, JSX, TypeScript, and TSX
- Working-tree and staged Git changes
- Function, comment, abstraction, whole-change, and module-placement rules
- Repository-aware evidence from imports, same-file and cross-file callers, implementations, and option usage
- Before/after evidence for change-level judgments
- Token-budgeted evaluation batches with recursive token-limit recovery
- Bounded failure summaries when an individual evaluation cannot complete
- TypeScript configuration
- Repository-local, content-addressed Jev response caching
- Ranked text and versioned JSON review reports
- Three hundred bundled Jev rules
- A local Oxlint anti-slop plugin for deterministic TypeScript checks

The bundled Jev rules are catalogued in `src/defaults.ts` (rule set, order, scope, and question text).

The API-contract rules use Oxc to prove that an argument changes, trace confirmed and possible I/O boundaries through project imports, extract sentinel return paths, or show that a value-returning function invokes a possible command. Jev then judges whether the contract discloses the behavior and cost. Pure copies, local calculations, explicit result types, and pure queries never reach Jev; explicit mutable protocols, clearly named I/O, intentional absence semantics, telemetry, and cache population remain valid.

The stability and type-safety rules use extracted wait bounds, promise tracking, module-scope mutation, and escape shapes to distinguish unbounded remote waits from wrapper-bounded calls, lost async work from awaited or guarded work, hidden cross-export coupling from load-time configuration, and unchecked boundary assumptions from guarded narrowing. The golden-comment rules pair iteration primitives with settlement signals, comparison operands with normalization symmetry, nullable origins with guard coverage, truthiness sites with domain types, host comparisons with anchoring evidence, and implementations with their resolved contracts, so Jev judges escaping async work, one-sided normalization, unguarded dereferences, falsy-as-absent checks, superstring host bypasses, and signature drift. The principles were adapted from Cursor's [Thermo-Nuclear Code Quality Review](https://github.com/cursor/plugins/blob/main/cursor-team-kit/skills/thermo-nuclear-code-quality-review/SKILL.md) and Matt Pocock's [Code Review](https://github.com/mattpocock/skills/blob/main/skills/engineering/code-review/SKILL.md).

The name-clarity rules pair identifier text with initializers, types, sibling declarations, and caller values, so Jev judges names that contradict their values, pun across meanings, compress past recognition, negate booleans, or drop units.

## Setup

Jevlint requires Node.js 22 or newer. The first live run asks for your Typesafe (Jev) API key and stores it, then continues the run. `jevlint setup` stores a key on demand (run it again to replace the stored key), and `jevlint setup --forget` removes it. The key is kept in the OS keychain when available, otherwise in a private config file.

For runs without prompting, set `JEVLINT_TYPESAFE_API_KEY` or pass `--token` (used for that run only, never stored); `--no-prompt` fails fast instead of asking. In CI, expose `JEVLINT_TYPESAFE_API_KEY` from your secret store and pass `--no-prompt`.

For development, Varlock loads `JEVLINT_TYPESAFE_API_KEY` from the `typesafe-api-key` item in the `van-tonder-nosudo` 1Password vault. The key never lives in the repository.

The 1Password service-account token must be available as `OP_SERVICE_ACCOUNT_TOKEN`. On the personal host, it comes from the existing nosudo secrets environment.

```sh
pnpm install
pnpm env:check
pnpm build
```

`pnpm jevlint` runs the built CLI through Varlock (`varlock run -- node dist/cli.js`, the `jevlint` script in `package.json`).

`pnpm env:check` prints only redacted values.

## Usage

Jevlint has two modes. `review` scores changed code only; `audit` surveys the whole codebase. Bare `jevlint` with no subcommand is `audit`: it surveys the full tree, or the given files or directories when paths are given. All three report probabilities only: no pass/fail, no thresholds, no bands.

```sh
pnpm jevlint
```

### review: changed code

Review staged and unstaged changes relative to `HEAD`, plus untracked source files:

```sh
pnpm jevlint review
```

Review only staged changes:

```sh
pnpm jevlint review --staged
```

On a clean tree there is nothing changed, so there is nothing to score. To score a clean tree, use `audit` below.

### audit: whole codebase

Survey every source file in the repository without needing a diff. An audit runs to completion by default: every candidate/rule pair is prepared. Opt into a limit only when you want one: `--max-questions` stops question preparation once that many evaluation questions are prepared, and `--evidence-budget-ms` bounds the preparation wall-clock. Remaining candidate/rule pairs are reported as omitted, in deterministic priority order (module candidates first by importer in-degree, then abstraction, function, and comment candidates by owner-file in-degree, start offset, and path).

```sh
pnpm jevlint audit
```

Bound a run with explicit limits:

```sh
pnpm jevlint audit --max-questions 2000
```

`--dry-run` prepares and counts questions without calling Jev, reporting coverage with zero live requests. Nothing is sampled and nothing is cut by score; what was not scored is listed in the report's `coverage` object with `complete: false`. Omission counts are candidate/rule pairs: prepared plus abstained plus omitted always equals the total pair count, so a truncated run states exactly which kinds and rules were never reached.

```sh
pnpm jevlint audit --max-questions 2000 --dry-run
```

Bound the preparation wall-clock with an opt-in budget; on expiry, remaining pairs are omitted:

```sh
pnpm jevlint audit --max-questions 2000 --evidence-budget-ms 60000
```

Change-scope rules (for example `jev/no-complexity-displacement`) need before/after change context, so an audit never scores them. They are listed under `coverage.unscoredRules` instead of being scored, and no change candidates are synthesized.

### Scoping runs to paths

`review` defaults to changed files; bare `jevlint` and `audit` default to every source file. Positional paths filter any scope to files or directories:

```sh
pnpm jevlint src/checkout
pnpm jevlint review src/checkout
pnpm jevlint audit src/checkout
```

A scope that matches nothing is an error, unless `--no-error-on-unmatched-pattern` is given, which exits 0 with an empty report instead.

Inspect the resolved scope, timings, or cache behavior without disturbing stdout. Stdout carries only the report or config JSON; all human chatter goes to stderr:

```sh
pnpm jevlint --rules
pnpm jevlint review --debug=files
pnpm jevlint review --debug=timings
pnpm jevlint review --debug=cache
pnpm jevlint review --print-config
```

`--rules` prints every bundled rule key, one per line (a JSON array with `--format json`), and exits without evaluating. It works with no subcommand and with `review` or `audit`. `--debug=files` prints the resolved scope file list and exits without evaluating. `--debug=timings` prints a per-rule timing table after the report. `--debug=cache` prints cache statistics. `--print-config` prints the effective config as JSON and exits without evaluating. Bare `jevlint --help` shows the general usage. Per-command help is available via `jevlint review --help` and `jevlint audit --help`.

Produce machine-readable output:

```sh
pnpm jevlint review --format json
```

Every evaluated rule/candidate pair is reported as a judgment with a probability, the rule's proposition, the candidate's file and span, its kind, and the bounded evidence behind the score. Text output ranks judgments by descending probability with deterministic tie-breaks, shows the top 5 by default, and ends with a summary line; when judgments are hidden by the limit, one hint line after the summary states the remaining count and how to see them:

```text
0.920  src/checkout.ts:12:3-12:40  function  jev/no-hidden-io  This API hides a material I/O boundary and its cost.
0.180  src/cart.ts:5:1-5:22  function  jev/no-narrating-comment  Comment restates nearby code.

2 evaluated; 2 displayed; 0 structurally abstained; 0 failed
```

With more than 5 judgments, text output keeps the top 5 and appends a hint line after the summary:

```text
0.920  src/checkout.ts:12:3-12:40  function  jev/no-hidden-io  This API hides a material I/O boundary and its cost.
0.610  src/payment.ts:8:1-8:44  function  jev/no-unsafe-retry  Retry repeats the charge without a safe policy.
0.420  src/totals.ts:14:1-14:52  function  jev/data-clump  Three parameters always travel together.
0.240  src/cart.ts:5:1-5:22  function  jev/no-narrating-comment  Comment restates nearby code.
0.180  src/coupon.ts:2:1-2:38  function  jev/needless-abstraction  Wrapper adds no behavior.

9 evaluated; 5 displayed; 0 structurally abstained; 0 failed
4 more judgments hidden; raise --limit, filter with --min-score, or use --format json for the full report.
```

`--min-score` filters before `--limit` is applied; `--limit` defaults to 5 for text output and may be raised, lowered, or set to 0. Both filter only the text rendering; the JSON report always contains every completed judgment in its `judgments` array, echoes the display options used, and `summary.displayed` reports the count the display filter selects, so text and JSON summaries stay identical. Evaluation always covers every candidate. Candidates that are structurally ineligible for a rule are summarized as abstention counts, never as zero scores.

Jev judgments are cached by default in the current worktree's Git metadata. Candidate discovery and repository evidence collection still run every time. Inspect a run, force fresh judgments, or bypass the cache with:

```sh
pnpm jevlint review --debug=cache
pnpm jevlint review --refresh-cache
pnpm jevlint review --no-cache
```

Normal runs print no cache status. See [Jev response cache](docs/caching.md) for the cache boundary, key inputs, storage, and security properties.

When using a globally linked binary, wrap it directly:

```sh
varlock run -- jevlint review
```

Scores never fail the command: a completed review exits 0 no matter how high the probabilities are. Invalid arguments, configuration failures, Git failures, and API failures produce exit code 2. Jevlint keeps judgments from completed batches when an evaluation fails, writes the report in the requested format, reports a bounded failure summary on stderr, and exits 2 to mark the run as incomplete.

## Known limitations

Repository evidence resolves relative JavaScript and TypeScript imports. TypeScript `paths` aliases and workspace package aliases are not resolved yet. Supporting them requires loading each repository's effective tsconfig and package export map; guessing from an import prefix would produce incorrect caller evidence.

## Configuration

Jevlint looks for `jevlint.config.ts` and common JavaScript module variants in the current directory. User rules extend the bundled rules. Set a bundled rule to `"off"` to disable it.

```ts
import { defineConfig } from "jevlint";

export default defineConfig({
  rules: {
    "jev/no-narrating-comment": "off",
    "personal/misleading-function-name": {
      scope: "function",
      question: {
        instructions: "Does this function's name misrepresent what its body does?",
        criteria: {
          true: "The name promises materially different behavior",
          false: "The name accurately summarizes the function's responsibility",
        },
      },
      message: "Function name does not match its behavior.",
    },
  },
});
```

Each rule uses a Jev Noul question, and every completed evaluation is reported as a probability at the Oxc candidate's source span. Bundled accidental-complexity rules first apply structural gates, so Jev is called only when Oxc finds the relevant mechanism. Repository evidence is bounded and rule-specific rather than a generic whole-project prompt. Jevlint pins the versioned `jev-1.13.0` model so cached judgments cannot silently outlive a moving model alias.

## Development

```sh
pnpm env:check
pnpm test
pnpm test:live
pnpm lint
pnpm check
pnpm build
```

The tests were written before the implementation. The normal suite uses deterministic evaluator fakes and does not spend TypeSafe credits. `pnpm test:live` loads the key through Varlock and checks the rule fixtures against the real Jev API.
