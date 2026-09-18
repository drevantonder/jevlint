# Rule ideas mined from systems/infra agent-coding standards

Meta-framing (not a rule): Cloudflare's Codex splits requirements into
mechanically-verifiable ones (custom linter packages — they standardize on
oxlint, cf. https://blog.cloudflare.com/engineering-standards-enforcement/)
versus judgment ones (AI reviewer). jevlint already mirrors this split:
Oxc prepass = mechanical eligibility, Jev = judgment. Prefer candidates
whose mechanical half is crisp.

Convention: each candidate gives source + link, the standard in one line,
a proposed jevlint proposition in falsifiable question form, a reshaping
note where the systems idea needs translation to JS/TS evidence, an
evidence sketch (Oxc nodes + repo evidence), and a strength rank.
Strong = statically checkable with a clear oracle. Weak = taste/vibes.

Ranked strongest first. Duplicates merged with citations.

---

## 1. Each error is handled exactly once (log XOR propagate)

- Source: Uber Go Style Guide, "Handle Errors Once"
  (https://github.com/uber-go/guide/blob/master/style.md);
  also HashiCorp Vault Go instructions, "Check error returns"
  (https://github.com/hashicorp/vault/blob/main/.github/instructions/generic/golang.instructions.md).
- Standard in one line: log the error or return it, never both — upstream
  callers handle it again, so log-and-return is log spam.
- Proposed proposition: "Does this changed catch block (or error branch)
  both record the error (console/logger/telemetry call) AND propagate it
  (rethrow, `return err`, `Promise.reject`), handling one failure twice?"
- Reshaping: Go returns errors up the stack; JS throws them. Map "return
  err" to `throw` / rejected-promise propagation out of a `catch` that
  already logged.
- Evidence sketch: `CatchClause` (or `.catch()` callback) in the changed
  span containing both (a) a logging call (`console.*`, injected logger,
  `captureException`) and (b) a `ThrowStatement` / `return <err>` /
  `Promise.reject`. Both must reference the caught binding. No repo-wide
  evidence needed.
- Strength: strong. Two syntactic facts in one block; oracle is clear.

## 2. No swallowed failures (empty catch / discarded rejection)

- Source: Uber Go Style Guide, "Don't Panic" + "Handle Errors Once"
  (https://github.com/uber-go/guide/blob/master/style.md); HashiCorp
  terraform-provider-aws Go conventions, "Never discard an error with `_`"
  (https://hashicorp.github.io/terraform-provider-aws/go-for-contributors/);
  HashiCorp Vault Go instructions, "Always handle errors explicitly"
  (https://github.com/hashicorp/vault/blob/main/.github/instructions/generic/golang.instructions.md).
- Standard in one line: every failure signal is handled, returned, or
  logged — never silently dropped.
- Proposed proposition: "Does this changed code catch a failure and then
  discard it — empty `catch {}`, `.catch(() => {})`, `void promise`, or
  missing `catch`/`reject` handler — with no logging, recovery, or
  propagation?"
- Reshaping: Go's `_` discard and JS's empty-catch are the same sin;
  no translation needed beyond node types. Deliberate degrade-gracefully
  (Uber's good case: log + continue) must NOT match — the proposition
  requires *no* observable handling.
- Evidence sketch: `CatchClause` with empty body or body containing only
  comments; `CallExpression` `.catch` with no-op arrow; `UnaryExpression
  (void)` applied to a promise-typed call; `await` inside `try` with no
  `catch` at any enclosing changed scope. Optional repo evidence: the
  callee is documented/typed as throwing.
- Strength: strong. Empty-block detection is mechanical; only the
  "deliberate recovery" exclusion needs Jev.

## 3. No fire-and-forget async work

- Source: Uber Go Style Guide, "Don't fire-and-forget goroutines / Wait
  for goroutines to exit" (https://github.com/uber-go/guide/blob/master/style.md);
  HashiCorp Vault Go instructions, "Prefer structured concurrency patterns
  over ad-hoc goroutine creation"
  (https://github.com/hashicorp/vault/blob/main/.github/instructions/generic/golang.instructions.md).
- Standard in one line: every spawned unit of concurrent work has an
  owner that observes its completion and its errors.
- Proposed proposition: "Does this changed code start async work — a
  floating promise, an un-awaited call in an async function, `.then`
  without rejection handling, an async callback passed to a fire-and-forget
  API — whose completion and errors nobody observes?"
- Reshaping: goroutine → promise/`setTimeout`/`queueMicrotask`/event
  subscription. The Go "wait for exit" half maps to awaiting/joining;
  the "no goroutines in `init()`" half is split out as candidate 11.
- Evidence sketch: `ExpressionStatement` whose expression is a
  `CallExpression` returning a promise (floating promise);
  `await`-less promise call inside an `async` function;
  `NewExpression` / call starting workers without handle retention.
  Repo evidence: callee return type is `Promise` (from types, where
  available).
- Strength: strong. `no-floating-promises` is a classic static rule;
  Jev resolves the uncertain middle (intentionally detached work with
  its own `.catch`).

## 4. No mutable module-global state

- Source: Uber Go Style Guide, "Avoid Mutable Globals"
  (https://github.com/uber-go/guide/blob/master/style.md); HashiCorp Vault
  Go instructions, "Avoid global variables when possible"
  (https://github.com/hashicorp/vault/blob/main/.github/instructions/generic/golang.instructions.md).
- Standard in one line: shared mutable globals make behavior depend on
  import order and hidden coupling — pass dependencies explicitly.
- Proposed proposition: "Does this changed code introduce module-level
  mutable bindings (`let`/`var`, exported mutable objects/arrays, mutable
  singletons) that any importer can observe or mutate?"
- Reshaping: near-direct translation. JS carve-outs a senior would allow:
  frozen config constants, memoized pure caches — Jev weighs these, the
  proposition stays falsifiable.
- Evidence sketch: top-level (`Program` scope) `VariableDeclaration`
  with `let`/`var`, or `const` bound to a mutated object literal;
  `ExportNamedDeclaration` of same. Abstain when the binding is
  `Object.freeze`d or never assigned outside initialization.
- Strength: strong. Scope + kind + export status are all mechanical.

## 5. Error context is succinct, not stacked boilerplate

- Source: Uber Go Style Guide, "Error Wrapping" — "keep the context
  succinct by avoiding phrases like 'failed to', which state the obvious
  and pile up as the error percolates up"
  (https://github.com/uber-go/guide/blob/master/style.md).
- Standard in one line: each wrap layer adds *new* context in a few
  words; "failed to X: failed to Y" chains are noise.
- Proposed proposition: "Does this changed error construction restate the
  obvious ('failed to', 'error:', 'could not') or duplicate context the
  wrap chain already carries, instead of adding new information?"
- Reshaping: Go `fmt.Errorf("…: %w")` chains → JS `new Error(msg,
  { cause })` / message-prefix chains. Same piling behavior.
- Evidence sketch: string literals / template literals in `NewExpression
  (Error…)` or `Error()` calls inside the changed span, matched against a
  small boilerplate-phrase list; `cause` chains where outer and inner
  messages share content words. Repo evidence: the same phrase already
  appears in the wrapped callee's message.
- Strength: medium-strong. Phrase list is mechanical; "adds new
  information" needs Jev.

## 6. Copy mutable inputs at trust boundaries

- Source: Uber Go Style Guide, "Copy Slices and Maps at Boundaries"
  (https://github.com/uber-go/guide/blob/master/style.md).
- Standard in one line: storing a caller's slice/map reference (or
  returning internal state by reference) lets outsiders mutate your
  invariants — copy at the boundary.
- Proposed proposition: "Does this changed function store a
  caller-provided array/object reference into longer-lived state
  (`this.*`, closure, module scope, cache) without copying, or return an
  internal collection by reference to the caller?"
- Reshaping: Go slices/maps → JS arrays/objects (reference semantics
  identical). `structuredClone` / spread / `Array.from` / `Map` copies
  are the idiomatic defense.
- Evidence sketch: `AssignmentExpression` in the changed span where the
  RHS is a bare parameter identifier (or member thereof) and the LHS is
  `this.*` / outer-scope binding; `ReturnStatement` returning a
  `this.*` / module-level collection. Abstain when RHS is visibly copied
  (spread, `.slice()`, `structuredClone`, `new Map(orig)`).
- Strength: medium-strong. Assignment shape is static; whether the
  callee/caller can actually mutate across the boundary needs Jev
  (alias lifetime judgment).

## 7. Comments record the surprise, not the syntax

- Source: HashiCorp terraform-provider-aws Go conventions, "Comment the
  surprise, not the syntax" — delete comments that restate the line,
  name the obvious operation, paraphrase the signature
  (https://hashicorp.github.io/terraform-provider-aws/go-for-contributors/);
  Google eng-practices, comments "mostly explain *why* instead of *what*"
  (https://google.github.io/eng-practices/review/reviewer/looking-for.html).
- Standard in one line: a comment must carry information the code cannot
  — constraints, invariants, rejected alternatives — never a paraphrase
  of the adjacent line.
- Proposed proposition: "Does this changed comment restate what the
  immediately adjacent code visibly does (operation, signature, section
  header) instead of recording a non-obvious reason, constraint, or
  invariant?"
- Reshaping: none needed — comments are language-agnostic. JS-specific
  carve-out: JSDoc/type annotations are documentation, not commentary;
  abstain on those.
- Evidence sketch: `Comment` nodes added in the diff paired with their
  next-sibling statement; word-overlap between comment tokens and the
  statement's identifiers/callee names. Short paraphrase + high overlap
  = mechanical pre-filter; Jev judges "surprise content".
- Strength: medium. Tight scope (comment + one sibling), but
  restatement-vs-reason is genuinely a judgment call.

## 8. Earn your abstractions (no speculative generality)

- Source: Google eng-practices, "over-engineering … solve the problem
  they know needs to be solved *now*"
  (https://google.github.io/eng-practices/review/reviewer/looking-for.html);
  HashiCorp terraform-provider-aws Go conventions, "Earn your abstractions"
  + "When in doubt, fewer concepts"
  (https://hashicorp.github.io/terraform-provider-aws/go-for-contributors/);
  DHH/Rails doctrine, "conceptual compression" + "omakase" defaults
  (https://rubyonrails.org/doctrine).
- Standard in one line: start concrete; add the interface/option-bag/
  generic only when a second real use proves it pays.
- Proposed proposition: "Does this changed code introduce abstraction
  machinery — an interface/type with one implementation, an options bag
  with one caller, a generic helper with one call site, a new module
  with one consumer — that no second use justifies?"
- Reshaping: Go "consumer-defined interfaces" → TS "interface with a
  single implementer"; Go package-splitting → new-file/module-splitting
  (pairs with candidate 12). The DHH angle (prefer framework/compression
  defaults over bespoke machinery) folds into candidate 10; cited here
  for the shared root.
- Evidence sketch: Oxc gives the introduced declarations (interfaces,
  type params, options types, new files); **repo evidence is load-bearing**:
  count implementations/callers/importers across the repo. Single use =
  candidate; Jev weighs "extension point the domain obviously needs"
  vs speculation.
- Strength: medium. Single-use counting is mechanical; "justified
  extension point" is judgment. Risk of nagging on reasonable seams —
  score, don't gate (per ADR-0001, always).

## 9. Keep control flow visible (early return; no trivial-helper scatter)

- Source: HashiCorp terraform-provider-aws Go conventions, "Keep control
  flow visible … Handle errors and exceptional cases early, then return"
  + "Don't extract three obvious lines into `buildRequest`"
  (https://hashicorp.github.io/terraform-provider-aws/go-for-contributors/);
  Uber Go Style Guide, "Reduce Nesting", "Unnecessary Else"
  (https://github.com/uber-go/guide/blob/master/style.md); Google
  eng-practices, "Too complex usually means can't be understood quickly
  by code readers"
  (https://google.github.io/eng-practices/review/reviewer/looking-for.html).
- Standard in one line: straight-line code with early exits; nesting and
  jump-to-learn-less helpers are reader taxes.
- Proposed proposition: "Does this changed function nest conditionals or
  loops 3+ deep where early returns would flatten it, or split a
  straight-line flow across single-call-site helpers that force the reader
  to travel to learn less?"
- Reshaping: Go's `if err != nil { return }` idiom → JS early-return /
  guard clauses; identical shape. The helper-scatter half pairs with
  candidate 8's machinery test but targets readability, not generality.
- Evidence sketch: nesting depth of `IfStatement`/`For*`/`While`/
  `SwitchStatement` within the changed function (mechanical); introduced
  functions with exactly one repo-wide call site whose body is ≤ a few
  statements (repo evidence). Jev decides whether the nesting carries
  real branching logic or is flattenable.
- Strength: medium. Depth counting is exact; "would read better flat"
  is judgment, and seniors disagree on thresholds.

## 10. Reach for what already exists (no hand-rolled platform)

- Source: HashiCorp terraform-provider-aws Go conventions, "Reach for
  what already exists … check whether the standard library … already
  does the job" (https://hashicorp.github.io/terraform-provider-aws/go-for-contributors/);
  DHH/Rails doctrine, conceptual compression via framework defaults
  (https://rubyonrails.org/doctrine); Thorsten Ball's agent-building
  ethos — a working agent in <400 lines, "it's an LLM, a loop, and enough
  tokens … the rest is elbow grease" (https://ampcode.com/how-to-build-an-agent)
  cited for the *simplest-thing-that-works* root shared with candidates 8–9.
- Standard in one line: before adding a dependency, helper framework, or
  hand-rolled utility, use the runtime/stdlib or a dependency already
  present.
- Proposed proposition: "Does this changed code hand-roll logic — date
  math, deep clone, debounce/throttle, slugify, retry-with-backoff,
  UUIDs — that the JS runtime, Node stdlib, or an already-imported
  dependency provides?"
- Reshaping: Go stdlib (`strconv`, `sort`, `slices`) → `Intl`,
  `structuredClone`, `crypto.randomUUID`, `URL`/`URLSearchParams`,
  `node:` builtins. Needs a curated platform-capability list as oracle.
- Evidence sketch: `CallExpression` / function bodies in the changed span
  matched against the capability list (name + shape heuristics, e.g.
  manual date arithmetic, hand-rolled `debounce` with `setTimeout`);
  repo evidence: `package.json` / existing imports already containing a
  library for the job. Jev confirms functional equivalence.
- Strength: medium. Oracle is a maintainable list, not a law; near-miss
  semantics ("ours handles timezones X doesn't") are exactly the
  uncertainty Jev should score, not suppress.

## 11. No side-effectful work at module top level

- Source: Uber Go Style Guide, "Avoid `init()`", "No goroutines in
  `init()`", "Exit in Main" (https://github.com/uber-go/guide/blob/master/style.md).
- Standard in one line: setup that does I/O, spawns work, or can fail
  belongs in an explicit, callable, testable entry point — not in
  import-time magic.
- Proposed proposition: "Does this changed module perform I/O, spawn
  timers/workers, mutate shared state, or start async work at import
  time (top-level statements) rather than inside an explicit init/start
  function the host calls?"
- Reshaping: Go `init()` → ES module top-level evaluation. Same hazard:
  untestable ordering, uncatchable failure, action at a distance on
  import. Test-file top-level setup is the standard carve-out (abstain).
- Evidence sketch: `Program`-level `ExpressionStatement`s /
  `AwaitExpression`s in the changed file that call I/O, network, timer,
  or process-exit APIs; top-level `await` of side-effectful work.
  Pure declarations, frozen config, and function definitions abstain
  mechanically.
- Strength: medium. Top-level-call detection is easy; "is this call
  side-effectful" needs a known-API list plus Jev for the long tail.

## 12. Files are named for their contents; code lives with its domain

- Source: HashiCorp terraform-provider-aws Go conventions, Hall of Shame
  Exhibit C (`helpers.go` "spends that budget on nothing") + "locality:
  code that changes together … should stay together"
  (https://hashicorp.github.io/terraform-provider-aws/go-for-contributors/);
  Google eng-practices, "look at the CL in a broad context … the whole
  file" + "improving code health"
  (https://google.github.io/eng-practices/review/reviewer/looking-for.html);
  GitHub staff-engineer review philosophy (Sarah Vessels) — match existing
  patterns in the module, keep diffs small and follow-up-able
  (https://github.blog/developer-skills/github/how-to-review-code-effectively-a-github-staff-engineers-philosophy/).
- Standard in one line: a file named `helpers`/`utils`/`common` promises
  miscellany; domain code belongs with the domain file that already owns
  it.
- Proposed proposition: "Does this changed file's name promise miscellany
  (`helpers`, `utils`, `common`, `misc`, `shared`) while its added
  exports belong to one domain that already has a home file in the repo?"
- Reshaping: Go Exhibits C–E are about packages/files; JS/TS maps
  directly onto barrel/misc files. Vessels' "match the pattern used in
  other classes in this module" is the positive form of the same check.
- Evidence sketch: filename against a miscellany-name list (mechanical);
  **repo evidence**: added exports' identifier/domain vocabulary vs
  sibling files' exports — would the new function sit naturally in an
  existing domain file? Jev judges domain fit; abstain when no sibling
  claims the domain (genuinely new capability).
- Strength: medium-weak. Filename half is exact; "belongs elsewhere" is
  a domain-similarity judgment with real false-positive risk — rank
  lowest of the keepers.

---

## Rejected (weakest cut)

- **"Start enums at one / zero values must be useful"** (Uber; Effective
  Go). Go-specific: the hazard is the zero value silently meaning
  something. TS string-union types and `undefined`-narrowing mostly
  dissolve it; no falsifiable JS proposition survived reshaping. Cut.
- **"Channel size is one or none"** (Uber). No honest JS analogue —
  bounded-queue discipline exists but changed-code evidence for it is
  contrived. Cut as forced.
- **DHH Majestic Monolith / microservices-recovery** (https://signalvnoise.com/svn3/the-majestic-monolith/).
  Architecture taste at repo scale, not a per-candidate falsifiable
  proposition over a changed span. Cut — its checkable residue (fewer
  concepts, candidate 8) was kept.
- **Primeagen-style performance hot-takes** (allocation/iterator
  folklore). Without a profiling oracle every proposition is vibes;
  "profile before optimizing" (Vault instructions) is itself the
  anti-rule. Cut.
- **"Getters drop the `Get` / initialisms keep one case"** (Terraform
  naming, Uber naming). Statically checkable but trivially mechanical —
  Oxc lint territory, no Jev uncertainty, low review value. Cut as
  below the Jev bar, not as wrong.
- **Thorsten Ball "How to Build an Agent" as a standalone source**
  (https://ampcode.com/how-to-build-an-agent). Valuable ethos
  (smallest working loop, tools + iteration), but its minable content
  collapses into candidates 8–10's shared root; kept as citation, not
  as its own rule. Same for Ball's "How I Prompt" talk.
- **Cloudflare Codex RFC workflow / SHOULD-vs-MUST governance.** Process
  machinery for owning standards, not a review proposition. Its
  transferable insight (mechanical-vs-judgment split) is recorded in the
  framing note instead.
