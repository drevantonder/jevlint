# jevlint

A diff-aware probabilistic code review tool for JavaScript and TypeScript. Oxc discovers candidates and builds rule-specific repository evidence. [Jev](https://docs.typesafe.ai/introduction) makes narrow semantic judgments and returns probabilities. Jevlint reports every judgment with its evidence and does not decide pass or fail.

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
- One hundred ninety-one bundled Jev rules
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
- functions that reimplement logic already owned elsewhere
- branches that dispatch on a domain type code its variants should own
- validators that reimplement an installed schema dependency
- retry loops that reimplement an installed retry dependency
- concurrency limiters that reimplement an installed limiter
- timing wrappers that reimplement an installed debounce dependency
- row splitters that reimplement an installed CSV dependency
- boolean parameters that select between behaviors
- call chains that navigate objects the caller should not know
- functions that mix raw mechanics with domain-level operations
- network or I/O waits without a deadline, timeout, or cancellation bound
- asynchronous work detached from completion tracking and error handling
- module-level mutable state shared across the module's exports
- type-system escapes that hide unchecked assumptions from the compiler
- per-item async work that escapes the surrounding error handling
- comparisons that normalize one side but not the other
- dereferences that can reach an absent value without a guard
- presence checks that treat valid falsy values as absent
- host checks that match substrings instead of domain boundaries
- implementations that disagree with the contract signature they claim to satisfy
- loops that serialize independent iterations by awaiting each one
- array transformations whose discarded result hides lost computation or misused iteration
- async markers without await that callers depend on as promises
- sink calls incorporating untrusted input without visible neutralization
- subscriptions or acquisitions with no release tied to the owner's lifetime
- signatures that callers cannot use without reading the implementation
- functions that depend on another module's internals past its advertised interface
- types whose behavior lives entirely in their clients
- fields that hold a value during only part of the object's lifetime
- classes that bundle unrelated responsibilities over disjoint state
- modules changed for unrelated reasons that should live apart
- siblings that expose needlessly different interfaces for the same operation
- subclasses that discard behavior their inheritance link still promises
- positional parameter lists that describe an object the code never names
- weak randomness guarding adversary-facing secrets
- defensive checks guarding cases no caller can produce
- deferred-work markers without accountable follow-through
- nested-quantifier patterns running against adversary-shaped input
- hard-coded secrets that look like live credentials
- results delivered through output parameters instead of returns
- raised or re-raised errors that carry no facts about the failure
- preconditions callers observably violate with no stated guard
- comments that warn of a hazard no code enforces
- cross-boundary values consumed without shape verification
- pre-update bindings used after fresher values were derived
- visible effects performed before rejecting gates
- authorization predicates with wrong operators or scopes
- literals duplicating repository-owned configuration
- near-identical sibling identifiers used where the other was meant
- conditionals that enumerate a data mapping a lookup could state directly
- functions that bundle sequential phases sharing no dataflow
- values that mirror source-owned state through manual sync code
- business-logic functions that build their own concrete collaborators
- sibling callers that retry the same dependency without spread or bounds
- collections that grow without eviction or size bound
- loops that perform one persistence round-trip per item
- fan-outs that launch unbounded concurrent work per input item
- shared bindings mutated from concurrent callbacks without coordination
- logging or telemetry calls that record secrets or personal data
- navigation targets from caller-controlled input with no allow-check
- cross-origin grants that trust any origin rather than a named set
- filesystem paths incorporating unvalidated segments that can escape their directory
- member accesses that name something the owning module never defines
- fallbacks that launder a contract breach into ordinary emptiness
- comments that assert behavior no test or caller pins
- additions that follow a different convention than their owning module
- handlers that repeat failure handling the module already owns once
- guards that narrow nothing the flow had not already settled
- parameters that carry a wider object than the function uses
- layers that mirror their collaborator without adding meaning
- code that carries prototype markers yet serves production callers
- loops whose exit is decided mid-body where the header does not state it
- sibling operations that report the same failure through incompatible channels
- changes that reshape a relied-upon export without a migration path
- functions that extend positionally while their neighbors extend through an options bag
- sibling operations that spell the same absence in different ways
- default parameter values shared across calls and mutated per call
- synchronous calls that block the event loop inside a serving path
- lazy async initializers that can run twice under concurrent first use
- promise combinators that discard leg work or failures the flow needs
- timers that outlive their owner because no teardown releases them
- worker-shared memory accessed without atomic coordination
- date arithmetic that assumes fixed-length days across daylight saving and zone changes
- monetary amounts passing through binary floating arithmetic that accumulates error
- listings that paginate by offset over changing data, so pages drift
- calls that mix unit scales the surrounding convention distinguishes
- parses that silently truncate input at the edges, so malformed values look valid
- dates that cross a boundary in locale-rendered form and cannot round-trip
- overloads that admit the same call shape for different meanings
- same-stem siblings that hide which member suspends
- barrels that re-export internals their clients were never meant to depend on
- code that protects data with a hash or cipher the industry no longer accepts
- connections that disable TLS identity verification on real transports
- runtime sinks that compile caller-shaped text into behavior
- sort orders that compare human-visible text without locale awareness
- fallbacks that re-enter the same failing capability they replace
- producers that enqueue work with no handling for a full or unavailable queue
- servers that accept work with no graceful shutdown path
- serving entries that expose traffic endpoints but no health or readiness signal
- code that assumes its deployment environment instead of receiving it
- tests that exercise their subject without stating any expectation
- tests that wait a fixed duration instead of awaiting a condition
- tests that decide what to check with branches or loops
- tests that verify their own doubles rather than the subject
- fixtures that duplicate a setup maintained elsewhere while the copies disagree
- feature flags that no longer gate live behavior while readers still reason through both arms
- interactive elements that expose no accessible name to assistive technology
- user-visible strings baked into code with no internationalization path
- debugging output sitting in a shipped path instead of a logger or nowhere
- nominal paths buried under layers of nesting
- caching, memoization, or batching layers with no shown hotspot, benchmark, or invalidation policy
- schema edits that constrain stored data with no migration, default, or reader-compatibility handling
- telemetry emitted where nothing in the repository consumes it
- user strings branching quantity wording on English grammar instead of locale plural rules
- configuration read through a new channel while the repository already owns one
- new flags gating behavior with no named owner, tracked ticket, or expiry note
- calls that use an API the owning module marks superseded while siblings use the successor
- imports that name a package no manifest in the repository declares
- tests that pin internal interactions instead of the observable outcome
- changes that add a dependency for a single trivial call site
- imports that add a second library for a capability the shelf already covers
- tests that repeat fixture setup the module already owns once
- boundary branches that decide values no test or caller pins
- access decisions enforced only in client or routing code
- checks and dependent mutations separated by an await on the same resource
- retries repeating state-changing operations with no idempotency identity
- modules owning a concept the repository already owns elsewhere
- error boundaries guarding the wrong span while a fallible neighbor sits outside
- branches that handle the rare case first while the nominal outcome waits in else
- conditional expressions that perform side effects or nest like statements
- boolean expressions too complex to hold without an explanatory name
- expressions that rely on expert-only idioms instead of stating intent
- decisive logic hidden inside nested conditional expressions readers must simulate
- behavior steered by literals that no name in scope explains
- inner bindings reusing a visible outer name for a different meaning
- functions forcing readers to track more live values than the outcome requires
- date assemblies that reimplement Intl.DateTimeFormat without a pinned-output need
- time-ago ladders that reimplement Intl.RelativeTimeFormat without a copy need
- number assemblies that reimplement Intl.NumberFormat without a pinned-output need
- query handling that reimplements URLSearchParams without a shape need
- tests placed far from their subjects while the repository colocates them
- unrelated exports added to miscellaneous modules instead of owned homes
- imports reaching past a feature's barrel into its internals
- imports climbing levels to modules with a nearer entry point

The API-contract rules use Oxc to prove that an argument changes, trace confirmed and possible I/O boundaries through project imports, extract sentinel return paths, or show that a value-returning function invokes a possible command. Jev then judges whether the contract discloses the behavior and cost. Pure copies, local calculations, explicit result types, and pure queries never reach Jev; explicit mutable protocols, clearly named I/O, intentional absence semantics, telemetry, and cache population remain valid.

The stability and type-safety rules use extracted wait bounds, promise tracking, module-scope mutation, and escape shapes to distinguish unbounded remote waits from wrapper-bounded calls, lost async work from awaited or guarded work, hidden cross-export coupling from load-time configuration, and unchecked boundary assumptions from guarded narrowing. The golden-comment rules pair iteration primitives with settlement signals, comparison operands with normalization symmetry, nullable origins with guard coverage, truthiness sites with domain types, host comparisons with anchoring evidence, and implementations with their resolved contracts, so Jev judges escaping async work, one-sided normalization, unguarded dereferences, falsy-as-absent checks, superstring host bypasses, and signature drift. The principles were adapted from Cursor's [Thermo-Nuclear Code Quality Review](https://github.com/cursor/plugins/blob/main/cursor-team-kit/skills/thermo-nuclear-code-quality-review/SKILL.md) and Matt Pocock's [Code Review](https://github.com/mattpocock/skills/blob/main/skills/engineering/code-review/SKILL.md).

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
