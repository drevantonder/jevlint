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
- Three hundred nineteen bundled Jev rules
- A local Oxlint anti-slop plugin for deterministic TypeScript checks

The bundled Jev rules are catalogued in `src/defaults.ts` (rule set, order, scope, category, and question text).

The API-contract rules use Oxc to prove that an argument changes, trace confirmed and possible I/O boundaries through project imports, extract sentinel return paths, or show that a value-returning function invokes a possible command. Jev then judges whether the contract discloses the behavior and cost. Pure copies, local calculations, explicit result types, and pure queries never reach Jev; explicit mutable protocols, clearly named I/O, intentional absence semantics, telemetry, and cache population remain valid.

The stability and type-safety rules use extracted wait bounds, promise tracking, module-scope mutation, and escape shapes to distinguish unbounded remote waits from wrapper-bounded calls, lost async work from awaited or guarded work, hidden cross-export coupling from load-time configuration, and unchecked boundary assumptions from guarded narrowing. The golden-comment rules pair iteration primitives with settlement signals, comparison operands with normalization symmetry, nullable origins with guard coverage, truthiness sites with domain types, host comparisons with anchoring evidence, and implementations with their resolved contracts, so Jev judges escaping async work, one-sided normalization, unguarded dereferences, falsy-as-absent checks, superstring host bypasses, and signature drift. The principles were adapted from Cursor's [Thermo-Nuclear Code Quality Review](https://github.com/cursor/plugins/blob/main/cursor-team-kit/skills/thermo-nuclear-code-quality-review/SKILL.md) and Matt Pocock's [Code Review](https://github.com/mattpocock/skills/blob/main/skills/engineering/code-review/SKILL.md).

The name-clarity rules pair identifier text with initializers, types, sibling declarations, and caller values, so Jev judges names that contradict their values, pun across meanings, compress past recognition, negate booleans, or drop units.

## Setup

Jevlint requires Node.js 22 or newer. It reads one credential, the `TYPESAFE_API_KEY` environment variable. Set it before any live run; nothing is stored anywhere. When it is missing or empty, jevlint prints one error naming the variable and exits 2. In CI, set `TYPESAFE_API_KEY` from the secret store. The key never lives in the repository.

```sh
pnpm install
pnpm build
```

`pnpm jevlint` runs the built CLI (`node dist/cli.js`, the `jevlint` script in `package.json`).

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

Emit GitHub workflow annotations, one per judgment:

```sh
pnpm jevlint review --format github
```

Each annotation carries the judgment's file with its line/column span, a `category` property naming the rule's category, and the
probability in the message. Annotations cover every judgment in category order; `--min-score`
and `--limit` only shape the text rendering. Exit behavior is unchanged:
annotations never mark a run incomplete.

Write per-file artifacts alongside the normal report:

```sh
pnpm jevlint audit --out-dir ./jevlint-out
```

`--out-dir` writes one JSON file per evaluated file (`<dir>/<path>.json` with
that file's judgments and file-scoped abstention counts) as files complete,
plus `summary.json` with the full report once the run finishes. Stdout still
carries the normal report, so `--out-dir` composes with `--format` (including
github), `review`, `audit`, paths, and `--staged`. With `audit --dry-run`,
only `summary.json` is written, since nothing is evaluated.

Every evaluated rule/candidate pair is reported as a judgment with a probability, the rule's proposition, its category, the candidate's file and span, its kind, and the bounded evidence behind the score. Text output orders judgments by category rank first, then by descending probability within each category (with deterministic tie-breaks), shows the top 5 by default, and ends with a summary line; when judgments are hidden by the limit, one hint line after the summary states the remaining count and how to see them:

```text
0.920  src/checkout.ts:12:3-12:40  function  performance  jev/no-hidden-io  This API hides a material I/O boundary and its cost.
0.180  src/cart.ts:5:1-5:22  function  style  jev/no-narrating-comment  Comment restates nearby code.

2 evaluated; 2 displayed; 0 structurally abstained; 0 failed
```

With more than 5 judgments, text output keeps the top 5 and appends a hint line after the summary:

```text
0.920  src/checkout.ts:12:3-12:40  function  performance  jev/no-hidden-io  This API hides a material I/O boundary and its cost.
0.610  src/payment.ts:8:1-8:44  function  reliability  jev/no-unsafe-retry  Retry repeats the charge without a safe policy.
0.420  src/totals.ts:14:1-14:52  function  maintainability  jev/data-clump  Three parameters always travel together.
0.240  src/cart.ts:5:1-5:22  function  style  jev/no-narrating-comment  Comment restates nearby code.
0.180  src/coupon.ts:2:1-2:38  function  maintainability  jev/needless-abstraction  Wrapper adds no behavior.

9 evaluated; 5 displayed; 0 structurally abstained; 0 failed
4 more judgments hidden; raise --limit, filter with --min-score, or use --format json for the full report.
```

`--min-score` filters before `--limit` is applied; `--limit` defaults to 5 for text output and may be raised, lowered, or set to 0. Both filter only the text rendering; the JSON report always contains every completed judgment in its `judgments` array, echoes the display options used, and `summary.displayed` reports the count the display filter selects, so text and JSON summaries stay identical. Evaluation always covers every candidate. Candidates that are structurally ineligible for a rule are summarized as abstention counts, never as zero scores.

### Display order (categories)

Every rule carries one category naming the kind of harm its proposition is about. Reports order judgments by category rank first, then by probability within each category, so a 0.75 security hole reads above a 0.95 naming nit. Categories order; they never filter, gate, or decide — there is no `--only-security` flag, and scores stay probabilities throughout.

In rank order:

- `security` — an attacker could exploit it (open auth, leaked secrets, injection, unsafe trust, weak crypto). Reads first because a likely exploit outweighs any bug.
- `correctness` — the code does the wrong thing on paths it runs (wrong values, broken contracts, lost distinctions, crashes on ordinary input).
- `reliability` — fine on the easy path, fails under faults, concurrency, time, load, or operations (swallowed errors, races, leaks, missing shutdown).
- `performance` — the right answer at too high a cost (hidden I/O, needless round trips, unbounded work).
- `maintainability` — hard to change safely (coupling, duplication, layering, dead code, test design).
- `style` — hard to read locally (names, comments, expression shape). Reads last because a confusing line never outweighs a failing one.

The category is static metadata assigned once per rule (see `src/defaults.ts`), rides each judgment in text, JSON, and github output, and never appears in propositions or evidence. There is no severity axis: probabilities already carry the uncertainty, and a severity tag would only invite threshold-style reading.

Jev judgments are cached by default in the current worktree's Git metadata. Candidate discovery and repository evidence collection still run every time. Inspect a run, force fresh judgments, or bypass the cache with:

```sh
pnpm jevlint review --debug=cache
pnpm jevlint review --refresh-cache
pnpm jevlint review --no-cache
```

Normal runs print no cache status. See [Jev response cache](docs/caching.md) for the cache boundary, key inputs, storage, and security properties.

When using a globally installed binary, call it directly:

```sh
jevlint review
```

Scores never fail the command: a completed review exits 0 no matter how high the probabilities are. Invalid arguments, configuration failures, Git failures, and API failures produce exit code 2. Jevlint keeps judgments from completed batches when an evaluation fails, writes the report in the requested format, reports a bounded failure summary on stderr, and exits 2 to mark the run as incomplete.

## Known limitations

Repository evidence resolves relative JavaScript and TypeScript imports. TypeScript `paths` aliases and workspace package aliases are not resolved yet. Supporting them requires loading each repository's effective tsconfig and package export map; guessing from an import prefix would produce incorrect caller evidence.

Transitive test pinning follows one hop: when a test calls a public seam and the seam calls the candidate, the pinning-aware rules (`jev/no-unpinned-failure-path`, `jev/no-unpinned-boundary-branch`, `jev/no-unpinned-compat-quirk`) name the chain (test → seam → candidate) as a pinning fact for Jev to weigh. Two-hop chains are out of scope by design — they explode combinatorially and blur pinning attribution. Pinning informs, never silences: chains add evidence facts without changing abstention semantics.

## Configuration

Jevlint looks for `jevlint.config.ts` and common JavaScript module variants in the current directory. Set a bundled rule to `"off"` to disable it. A `rules` key that matches no bundled or plugin rule is an error, so misspelled keys fail loudly instead of scoring nothing.

```ts
import { defineConfig } from "jevlint";

export default defineConfig({
  rules: {
    "jev/no-narrating-comment": "off",
  },
});
```

One bundled rule is opt-in: `jev/no-unlocalized-user-string` stays off
unless a project explicitly enables it, because English-only developer CLIs
are the common case and flagging them would lecture a decision the team
already made. Enabling it also gates on i18n intent — a framework import,
a locale directory or data file, or project `Intl`/helper usage — so repos
without that intent abstain structurally instead of scoring. Enable it with
its bundled default (or a reshaped question) via `optInRuleDefaults`:

```ts
import { defineConfig, optInRuleDefaults } from "jevlint";

export default defineConfig({
  rules: {
    "jev/no-unlocalized-user-string": optInRuleDefaults["jev/no-unlocalized-user-string"],
  },
});
```

## Custom rules

Projects add rules by registering a local plugin file in the config. The entry `name` is the namespace prefix for every rule the file provides, and `specifier` is a project-local relative path resolved against the config file. Custom rules are enabled by default and use the same `rules` record as bundled rules: `"off"` disables one, and a full entry reshapes its scope, question, or message while keeping its evidence builder.

```ts
// jevlint.config.ts
import { defineConfig } from "jevlint";

export default defineConfig({
  plugins: [{ name: "acme", specifier: "./jevlint-rules/todo-tickets.ts" }],
  rules: {
    "acme/no-todo-without-ticket": "off",
  },
});
```

```ts
// jevlint-rules/todo-tickets.ts
import { definePlugin } from "jevlint";

export default definePlugin({
  name: "acme",
  rules: {
    "no-todo-without-ticket": {
      name: "no-todo-without-ticket",
      scope: "comment",
      category: "style",
      question: {
        instructions: "Does this TODO comment name a trackable ticket?",
      },
      message: "TODO comment names no trackable ticket.",
      buildEvidence: (candidate) =>
        /TODO/.test(candidate.source) ? { source: candidate.source } : undefined,
    },
  },
});
```

A rule descriptor is a scope (one of the five candidate kinds), a category (one of the six display-order categories below), a question and message in the same shape as bundled rules, and a synchronous `buildEvidence` function that returns evidence or `undefined` when the rule does not apply. Custom judgments appear in the review report, omission ledger, and audit coverage exactly like bundled ones. Plugin load problems exit 2 before any evaluation runs. The full contract lives in `docs/custom-rules-spec.md`.

Each rule uses a Jev Noul question, and every completed evaluation is reported as a probability at the Oxc candidate's source span. Bundled accidental-complexity rules first apply structural gates, so Jev is called only when Oxc finds the relevant mechanism. Repository evidence is bounded and rule-specific rather than a generic whole-project prompt. Jevlint pins the versioned `jev-1.13.0` model so cached judgments cannot silently outlive a moving model alias.

## Development

```sh
pnpm test
pnpm test:live
pnpm lint
pnpm check
pnpm build
```

The tests were written before the implementation. The normal suite uses deterministic evaluator fakes and never calls the Jev API. `pnpm test:live` reads the key from `TYPESAFE_API_KEY` and checks the rule fixtures against the real Jev API.
