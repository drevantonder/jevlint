# jevlint rule build list (triage of mined ideas)

Triage of `.scratch/rule-ideas-js.md` (11 ideas, JS/TS agent-coding standards)
and `.scratch/rule-ideas-systems.md` (12 ideas, systems/infra standards):
23 ideas combined → **9 build, 14 cut**. Per user canon there is no winner
cap: everything falsifiable + gatherable evidence + genuine uncertainty ships;
the cut list is duplicates-only and vibes-only.

Bar (user canon): the evidence is gathered statically, but the JUDGMENT is
the product. Every pick below states its uncertainty explicitly — where an
expert could disagree and a regex could not decide. Deterministic-decidable
candidates are oxlint territory and are cut as such, not kept. Dedup doctrine
throughout: never two rules for one smell; each pick names the nearest
registry id checked (319 keys in `src/defaults.ts`). Rule 189
(tautological-test assertion) is in flight and untouched.

All nine are independent (disjoint scopes, no shared evidence builders), so
builders parallelize freely; order below is judgment-depth rank (deepest
genuine uncertainty first, most-mechanical last).

---

## BUILD (9, deepest judgment first)

### 1. `jev/no-retained-caller-alias` — Sys-6, STORE HALF ONLY
- **Proposition:** "Does this changed function store a caller-provided
  array/object reference into longer-lived state without copying, letting
  later mutation on either side break the other's invariants?"
- **Evidence sketch:** assignment where RHS is a bare parameter (or member)
  and LHS is `this.*` / outer-scope / cache; abstain on visible copy
  (spread, `.slice()`, `structuredClone`, `new Map(orig)`). The RETURN half
  (internal collection returned by reference) is **excluded** — that is
  `jev/no-mutable-surface-expansion` territory.
- **Uncertainty (why Jev):** the static shape only opens the question.
  Whether either side can actually mutate across the boundary over the
  alias's lifetime — frozen objects, write-once init, trust-domain
  conventions — splits seniors; defensive-copy-everywhere vs
  copy-at-real-boundaries is a live disagreement no allowlist settles.
- **Checked against:** `jev/no-hidden-input-mutation` (mutating the input —
  distinct: retaining an alias vs mutating), `jev/no-mutable-surface-expansion`
  (return half overlaps — narrowed to avoid it). No overlap after narrowing.

### 2. `jev/no-indiscriminable-error` — JS-7
- **Proposition:** "Does this change throw or propagate an error callers
  cannot discriminate — bare `Error`, generic message, no code/marker/
  `cause` — where distinct failures need distinct handling?"
- **Evidence sketch:** `throw` / rethrow sites checked for subclass, code,
  marker, `cause`, status; catch sites that must branch on failure kind are
  the confirming repo evidence.
- **Uncertainty (why Jev):** "need distinct handling" is irreducibly
  contextual: it requires reading the callers' recovery options, and seniors
  disagree on how many failure kinds deserve their own discriminant vs one
  actionable message. No phrase list or API table can pre-decide it.
- **Checked against:** `jev/no-inconsistent-error-contract` (siblings
  disagreeing — distinct: single-throw discriminability),
  `jev/no-contextless-error` (no facts — distinct: discriminant vs facts).

### 3. `jev/no-stacked-error-boilerplate` — Sys-5
- **Proposition:** "Does this changed error construction restate the obvious
  ('failed to', 'could not') or duplicate context the `cause` chain already
  carries, instead of adding new information?"
- **Evidence sketch:** string/template literals in `Error` constructions
  matched against a boilerplate-phrase list; outer/inner `cause`-chain
  content-word overlap; same phrase already in the wrapped callee's message.
- **Uncertainty (why Jev):** "adds new information" is a reader judgment:
  what counts as obvious depends on who catches the error and what the
  surrounding layer already says. Terse-vs-explicit message style is a
  genuine taste split; the phrase list is a pre-filter, never a verdict.
- **Checked against:** `jev/no-misdirecting-error-message` (false cause —
  distinct), `jev/no-contextless-error` (no facts — near-opposite).

### 4. `jev/no-any-widened-interface` — JS-5
- **Proposition:** "Does this change expose `any` in a caller-visible
  position (parameter, return, exported type) where a narrower type was
  available, rather than confining `any` to generic internals?"
- **Evidence sketch:** `any` annotations/assertions in changed hunks by
  position; `(...args: any[]) => any` constraints and `as any` inside
  generic bodies with disable-comment/test backstop are the documented
  exceptions.
- **Uncertainty (why Jev):** "a narrower type was available" requires
  judging what the domain actually constrains — and any-tolerance itself
  splits seniors (pragmatic-migration vs strict-boundary camps). The
  generic-machinery exceptions are enumerated, but whether a given `any`
  earns one is argued case by case.
- **Checked against:** `jev/no-type-checker-escape` (escape hiding a
  wrong-assumption failure — distinct: API-widening vs failure-hiding).

### 5. `jev/no-shared-test-mutable-setup` — JS-11
- **Proposition:** "Do tests in this file share mutable setup state across
  cases — module/`describe`-scoped `let` assigned in one test or hook and
  read in another — instead of arranging isolated state per test?"
- **Evidence sketch:** outer-scope `let`/`var` assigned in
  `beforeAll`/`beforeEach`/`it` and read in a different `it`; single
  `beforeAll` render feeding multiple cases; per-test arrange is the
  counter-signal.
- **Uncertainty (why Jev):** the `let`-across-`it` shape is static, but
  whether the sharing actually couples outcomes (vs immutable fixtures and
  safe builders) needs data-flow judgment — and isolation appetite varies
  legitimately by team and suite speed. Two seniors read the same fixture
  file differently; that is the Jev case.
- **Checked against:** `jev/no-nondeterministic-test-input` (randomness/time
  luck — different). No overlap.

### 6. `jev/no-owned-module-mock` — JS-3
- **Proposition:** "Does this test replace a module the repository itself
  owns with a mock, rather than mocking at a genuine system boundary?"
- **Evidence sketch:** `jest.mock` / `vi.mock` targets resolved against the
  repo tree: in-repo target = signal; `node_modules` / network / clock /
  fs = counter-signal.
- **Uncertainty (why Jev):** path resolution is mechanical, but "genuine
  system boundary" is not: owned clock wrappers, SDK-style facades over
  fetch, and DI seams are all in-repo yet legitimate mock points by the
  sources' own rules. Seam legitimacy is argued per module, not per path.
- **Checked against:** `jev/no-mock-everything` (verifies-own-doubles —
  distinct proposition: wrong seam vs everything mocked). No overlap.

### 7. `jev/no-bare-json-parse` — JS-6
- **Proposition:** "Does this production path decode external/untrusted JSON
  with bare `JSON.parse` instead of a safe/validating parser, so malformed
  input throws an un-actionable error?"
- **Evidence sketch:** `JSON.parse(` sites in non-test source; argument
  traced toward network/response/file input vs local constant; absence of
  try/catch-with-context, schema validation, or safe wrapper at the site.
- **Uncertainty (why Jev):** input provenance shades continuously (user
  upload vs config file vs own API response), and fail-fast-vs-graceful
  splits seniors: crashing startup on a bad config is a virtue, crashing a
  request handler is a bug. The same call site reads differently per
  context — no static rule holds both.
- **Checked against:** `jev/no-unvalidated-boundary-shape` (assumed shape —
  distinct: unactionable throw vs unverified shape). No overlap.

### 8. `jev/no-import-time-side-effect` — Sys-11
- **Proposition:** "Does this changed module perform I/O, spawn
  timers/workers, mutate shared state, or start async work at import time
  rather than inside an explicit init/start function?"
- **Evidence sketch:** `Program`-level expression statements / top-level
  `await` calling I/O, network, timer, or process-exit APIs (known-API list
  + Jev for the tail); pure declarations, frozen config, and test-file
  setup abstain.
- **Uncertainty (why Jev):** the long tail of "is this side-effectful"
  resists any API list, and acceptability itself is disputed — env reads,
  diagnostic registration, and lazy-singleton wiring at import all have
  senior defenders and senior opponents. Ordering-hazard vs pragmatism is
  weighed per module.
- **Checked against:** `jev/no-hidden-initialization-order` (needs-separate-
  initializer — opposite direction), `jev/no-unguarded-async-init`
  (double-init race — different). No overlap.

### 9. `jev/no-log-and-propagate` — Sys-1 (closest to the oxlint line)
- **Proposition:** "Does this changed catch block both record the error
  (console/logger/telemetry) AND propagate it (rethrow / reject), handling
  one failure twice?"
- **Evidence sketch:** `CatchClause` / `.catch()` callback containing both a
  logging call and a `ThrowStatement` / `return <err>` / `Promise.reject`,
  both referencing the caught binding; upstream handlers checked for
  duplicate recording of the same failure.
- **Uncertainty (why Jev — and why last):** detection is near-mechanical,
  which is exactly why this sits at the bottom under the judgment bar. What
  keeps it ours: log-with-context-then-throw at layer boundaries is
  widespread defended practice, and Uber's never-both absolutism is not
  consensus — whether the log duplicates an upstream record or adds context
  no other layer has requires reading the handling chain. If builders find
  the verdict collapses to an allowlist, demote to oxlint and cut.
- **Checked against:** `jev/no-lopsided-error-handling` (asymmetric guarding
  across siblings — different), `jev/no-lossy-error-translation` (erased
  distinctions — different). No overlap.

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
