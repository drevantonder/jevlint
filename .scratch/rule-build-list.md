# jevlint rule build list (triage of mined ideas)

Triage of `.scratch/rule-ideas-js.md` (11 ideas, JS/TS agent-coding standards)
and `.scratch/rule-ideas-systems.md` (12 ideas, systems/infra standards):
23 ideas combined → **9 build, 14 cut**. Per user canon there is no winner
cap: everything falsifiable + statically checkable + uncovered ships, ordered
strongest-first; the cut list is duplicates-only and vibes-only.

Dedup doctrine applied throughout: never two rules for one smell. Every pick
below names the nearest registry id checked (319 keys in `src/defaults.ts`).
Rule 189 (tautological-test assertion) is in flight and untouched.

All nine are independent (disjoint scopes, no shared evidence builders), so
builders parallelize freely; order below is oracle-strength rank, i.e. the
suggested claim order.

---

## BUILD (9, strongest first)

### 1. `jev/no-log-and-propagate` — Sys-1
- **Proposition:** "Does this changed catch block both record the error
  (console/logger/telemetry) AND propagate it (rethrow / reject), handling
  one failure twice?"
- **Evidence sketch:** `CatchClause` / `.catch()` callback containing both a
  logging call and a `ThrowStatement` / `return <err>` / `Promise.reject`,
  both referencing the caught binding. No repo evidence needed.
- **Checked against:** `jev/no-lopsided-error-handling` (asymmetric guarding
  across siblings — different), `jev/no-lossy-error-translation` (erased
  distinctions — different). No overlap.
- **Why first:** strongest oracle on the list — two syntactic facts in one
  block, fully local, zero repo evidence.

### 2. `jev/no-owned-module-mock` — JS-3
- **Proposition:** "Does this test replace a module the repository itself
  owns with a mock, rather than mocking at a genuine system boundary?"
- **Evidence sketch:** `jest.mock` / `vi.mock` targets resolved against the
  repo tree: in-repo target = signal; `node_modules` / network / clock /
  fs = counter-signal.
- **Checked against:** `jev/no-mock-everything` (verifies-own-doubles —
  distinct proposition: wrong seam vs everything mocked). No overlap.
- **Why second:** path-resolution oracle is a bright line; test scope is
  disjoint from all other picks.

### 3. `jev/no-bare-json-parse` — JS-6
- **Proposition:** "Does this production path decode external/untrusted JSON
  with bare `JSON.parse` instead of a safe/validating parser, so malformed
  input throws an un-actionable error?"
- **Evidence sketch:** `JSON.parse(` sites in non-test source; argument
  traced toward network/response/file input vs local constant; absence of
  try/catch-with-context, schema validation, or safe wrapper at the site.
- **Checked against:** `jev/no-unvalidated-boundary-shape` (assumed shape —
  distinct: unactionable throw vs unverified shape). No overlap.

### 4. `jev/no-any-widened-interface` — JS-5
- **Proposition:** "Does this change expose `any` in a caller-visible
  position (parameter, return, exported type) where a narrower type was
  available, rather than confining `any` to generic internals?"
- **Evidence sketch:** `any` annotations/assertions in changed hunks by
  position; `(...args: any[]) => any` constraints and `as any` inside
  generic bodies with disable-comment/test backstop are the documented
  exceptions.
- **Checked against:** `jev/no-type-checker-escape` (escape hiding a
  wrong-assumption failure — distinct: API-widening vs failure-hiding).
  No overlap.

### 5. `jev/no-retained-caller-alias` — Sys-6, STORE HALF ONLY
- **Proposition:** "Does this changed function store a caller-provided
  array/object reference into longer-lived state without copying, letting
  later mutation on either side break the other's invariants?"
- **Evidence sketch:** assignment where RHS is a bare parameter (or member)
  and LHS is `this.*` / outer-scope / cache; abstain on visible copy
  (spread, `.slice()`, `structuredClone`, `new Map(orig)`). The RETURN half
  (internal collection returned by reference) is **excluded** — that is
  `jev/no-mutable-surface-expansion` territory.
- **Checked against:** `jev/no-hidden-input-mutation` (mutating the input —
  distinct: retaining an alias vs mutating), `jev/no-mutable-surface-expansion`
  (return half overlaps — narrowed to avoid it). No overlap after narrowing.

### 6. `jev/no-import-time-side-effect` — Sys-11
- **Proposition:** "Does this changed module perform I/O, spawn
  timers/workers, mutate shared state, or start async work at import time
  rather than inside an explicit init/start function?"
- **Evidence sketch:** `Program`-level expression statements / top-level
  `await` calling I/O, network, timer, or process-exit APIs (known-API list
  + Jev for the tail); pure declarations, frozen config, and test-file
  setup abstain.
- **Checked against:** `jev/no-hidden-initialization-order` (needs-separate-
  initializer — opposite direction), `jev/no-unguarded-async-init`
  (double-init race — different). No overlap.

### 7. `jev/no-stacked-error-boilerplate` — Sys-5
- **Proposition:** "Does this changed error construction restate the obvious
  ('failed to', 'could not') or duplicate context the `cause` chain already
  carries, instead of adding new information?"
- **Evidence sketch:** string/template literals in `Error` constructions
  matched against a boilerplate-phrase list; outer/inner `cause`-chain
  content-word overlap; same phrase already in the wrapped callee's message.
- **Checked against:** `jev/no-misdirecting-error-message` (false cause —
  distinct), `jev/no-contextless-error` (no facts — near-opposite).
  No overlap.

### 8. `jev/no-indiscriminable-error` — JS-7
- **Proposition:** "Does this change throw or propagate an error callers
  cannot discriminate — bare `Error`, generic message, no code/marker/
  `cause` — where distinct failures need distinct handling?"
- **Evidence sketch:** `throw` / rethrow sites checked for subclass, code,
  marker, `cause`, status; catch sites that must branch on failure kind are
  the confirming repo evidence.
- **Checked against:** `jev/no-inconsistent-error-contract` (siblings
  disagreeing — distinct: single-throw discriminability),
  `jev/no-contextless-error` (no facts — distinct: discriminant vs facts).
  Weakest oracle of the keepers; ranked last among error rules.

### 9. `jev/no-shared-test-mutable-setup` — JS-11
- **Proposition:** "Do tests in this file share mutable setup state across
  cases — module/`describe`-scoped `let` assigned in one test or hook and
  read in another — instead of arranging isolated state per test?"
- **Evidence sketch:** outer-scope `let`/`var` assigned in
  `beforeAll`/`beforeEach`/`it` and read in a different `it`; single
  `beforeAll` render feeding multiple cases; per-test arrange is the
  counter-signal.
- **Checked against:** `jev/no-nondeterministic-test-input` (randomness/time
  luck — different). No overlap.
- **Why last:** static shape is clear but outcome-coupling needs data-flow
  judgment and team appetite varies; genuine Jev uncertainty, not vibes.

---

## CUT (14, one line each)

- **Sys-2 swallowed failures → `jev/no-swallowed-error`.** Same smell, canonical exists.
- **Sys-3 fire-and-forget + JS-4 floating promise (merged, same smell) → `jev/no-detached-async-work`.** Canonical covers detached completion/error tracking exactly.
- **Sys-4 mutable module-global → `jev/no-shared-mutable-module-state`.** Same smell, canonical exists.
- **Sys-7 surprise-comments → `jev/no-narrating-comment`.** Same smell, canonical exists.
- **Sys-8 earn-abstractions → `jev/no-speculative-generality`.** Same smell, canonical exists.
- **Sys-9 visible-control-flow → `jev/no-deep-happy-path-nesting` (+ `jev/no-single-caller-exported-helper`).** Nesting half is the canonical; helper-scatter half is the same smell at a different visibility.
- **Sys-10 hand-rolled-platform genus → hand-rolled species family (`jev/no-hand-rolled-retry-loop`, `-uuid`, `-debounce`, …).** Genus rule would duplicate ~20 species; gaps want new species, not a genus.
- **Sys-12 miscellany-file → `jev/no-utils-grab-bag-growth`.** Same smell, canonical exists.
- **JS-1 tautological assertion.** In flight as rule 189 — do not re-propose.
- **JS-2 implementation-coupled tests → `jev/no-private-internals-assertion`.** Same smell, canonical exists.
- **JS-8 generic gateway → `jev/no-variant-partitioned-helper`.** String/options-discriminant dispatch split per variant is the same structural smell; mockability is motivation, not a distinct proposition.
- **JS-9 overlay title → `jev/no-unlabeled-interactive-element`.** Same smell (no accessible name), canonical exists.
- **JS-10 raw palette colors → `jev/no-duplicated-style-object`.** Token-exists-for-role overlaps the canonical; residue is theme-tuning noise, no stable oracle.
- **Scouts' own rejected lists** (Go zero-values, channel sizes, DHH monolith,
  perf folklore, naming micro-rules, RFC process; one-assert-per-test, TDD
  loop discipline, deep-module vocabulary, Fowler-as-lint, Tailwind
  micro-style, changesets/commits, Theo positioning) stay cut — process,
  vibes, or oxlint territory, no falsifiable candidate+evidence proposition.
