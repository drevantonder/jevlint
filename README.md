# jevlint

A diff-aware probabilistic code review tool for JavaScript and TypeScript. Oxc discovers candidates and builds rule-specific repository evidence. [Jev](https://docs.typesafe.ai/introduction) makes narrow semantic judgments and returns probabilities. Jevlint reports every judgment with its evidence and does not decide pass or fail.

## Status

This first slice supports:

- JavaScript, JSX, TypeScript, and TSX
- Working-tree and staged Git changes
- Function, comment, abstraction, and whole-change rules
- Repository-aware evidence from imports, same-file and cross-file callers, implementations, and option usage
- Before/after evidence for change-level judgments
- Token-budgeted evaluation batches with recursive token-limit recovery
- Bounded failure summaries when an individual evaluation cannot complete
- TypeScript configuration
- Repository-local, content-addressed Jev response caching
- Ranked text and versioned JSON review reports
- Forty-two bundled Jev rules
- A local Oxlint anti-slop plugin for deterministic TypeScript checks

The bundled Jev rules judge:

- mutation of caller-owned inputs that the function contract does not disclose
- network, disk, database, or process I/O hidden behind local-looking APIs
- sentinel returns that collapse caller-relevant outcomes
- state-changing commands concealed behind query-shaped APIs
- comments that repeat nearby code
- wrappers that add no meaningful behavior
- names that obscure a function's purpose
- speculative generality
- ad-hoc special-case branching
- functions that combine unrelated responsibilities
- repeated parameter groups that conceal a domain value
- business policy encoded independently in several modules
- correlated booleans that admit contradictory states
- unconstrained strings used as closed internal states
- flat records that permit invalid discriminant and payload combinations
- needless abstractions
- generic reflective machinery for fixed operations
- configuration disproportionate to observed use
- avoidable sequential orchestration
- runtime inputs hidden inside domain or application functions
- initialization order hidden behind mutable module state
- all-or-nothing domain operations without an explicit transaction or recovery policy
- changes that displace rather than reduce complexity
- domain behavior coupled directly to transport details
- persistence-owned models leaking into domain or application consumers
- bare primitive parameters that erase distinct domain identities
- domain policy originating inside transport, provider, or persistence adapters
- swallowed failures that leave caller-visible success or ordinary absence
- error translations that discard failure identity, cause, or actionable context
- retries that repeat failures or side effects without a safe policy
- batch operations that hide failed or omitted items behind apparent completion
- feature envy
- mutation of foreign, unowned state that the function contract does not disclose
- unenforced temporal call sequencing between setup and later operations
- single-concept changes scattered across many modules
- exported operations whose contract is stated nowhere callers can find it
- positional parameter lists that describe an object the code never names
- weak randomness guarding adversary-facing secrets
- defensive checks guarding cases no caller can produce
- deferred-work markers without accountable follow-through
- nested-quantifier patterns running against adversary-shaped input
- hard-coded secrets that look like live credentials

The API-contract rules use Oxc to prove that an argument changes, trace confirmed and possible I/O boundaries through project imports, extract sentinel return paths, or show that a value-returning function invokes a possible command. Jev then judges whether the contract discloses the behavior and cost. Pure copies, local calculations, explicit result types, and pure queries never reach Jev; explicit mutable protocols, clearly named I/O, intentional absence semantics, telemetry, and cache population remain valid.

The eleven accidental-complexity rules use Oxc for factual candidate discovery and evidence collection, then ask Jev to distinguish a smell from legitimate boundaries, workflows, variation, policy, and dependency constraints. The explicit-effects rules limit judgment to concrete runtime reads, mutable initialization dependencies, and effect-like calls. They exempt named boundary adapters, providers, lifecycle and callback-scoped contracts, and transaction or compensation mechanisms. Multiple effects alone never establish an atomicity violation. The scattered-policy rule proves repetition in the current repository; it does not infer historical shotgun change without change-history evidence. The state-modeling rules distinguish correlated lifecycle flags from independent booleans, closed internal states from open strings, and conditionally required payloads from optional metadata or boundary contracts. The four domain-boundary rules separate domain decisions from transport translation, keep persistence-owned records from becoming application or domain contracts, preserve distinct domain identities in project APIs, and keep business policy out of adapters. They preserve legitimate controllers, protocol obligations, domain reconstruction, read models, persistence tooling, ordinary value pairs, protocol representations, and technical adapter decisions. The failure-integrity rules use extracted handlers, control flow, dependencies, and callers to distinguish failures that lose meaning from explicit results, credible fallbacks, secure boundary translations, and genuinely best-effort work. The principles were adapted from Cursor's [Thermo-Nuclear Code Quality Review](https://github.com/cursor/plugins/blob/main/cursor-team-kit/skills/thermo-nuclear-code-quality-review/SKILL.md) and Matt Pocock's [Code Review](https://github.com/mattpocock/skills/blob/main/skills/engineering/code-review/SKILL.md).

## Setup

Jevlint requires Node.js 22 or newer. Varlock loads `TYPESAFE_API_KEY` from the `typesafe-api-key` item in the `van-tonder-nosudo` 1Password vault. The key never lives in the repository.

The 1Password service-account token must be available as `OP_SERVICE_ACCOUNT_TOKEN`. On the personal host, it comes from the existing nosudo secrets environment.

```sh
pnpm install
pnpm env:check
pnpm build
```

`pnpm env:check` prints only redacted values.

## Usage

Review staged and unstaged changes relative to `HEAD`, plus untracked source files:

```sh
pnpm jevlint review
```

Review only staged changes:

```sh
pnpm jevlint review --staged
```

Produce machine-readable output:

```sh
pnpm jevlint review --format json
```

`jevlint diff` remains as a compatibility alias for `jevlint review` with identical score output.

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
pnpm jevlint review --verbose
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
