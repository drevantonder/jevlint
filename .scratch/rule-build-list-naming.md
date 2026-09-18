# Naming rule build list (triage spec — no implementation)

Source: `.scratch/rule-ideas-naming.md` mined on
`bb/202-rule-mine-naming-fresh-thr_2sa6vrst3j` (10 ranked candidates + rejected
list). Triaged against the jevlint bar: falsifiable + gatherable evidence +
genuine uncertainty (an expert could disagree; a regex could not decide).
Deterministic-decidable = oxlint territory, CUT. Dedup doctrine: every pick
checked against the 300-key registry in `src/defaults.ts` — all cited
canonical ids verified present, no proposed key collides.

Contract reminder (docs/adr/0001): each rule scores ONE uncertain proposition
0..1 per judgment, never pass/fail. No thresholds or severities in rule specs.

Verdict: **SHIP 9, CUT 1 (+ scout's 14 rejected, endorsed).**

---

## Build list (strongest first — build in this order)

### 1. `jev/no-hidden-hook-contract` (ship first — strongest)

- **Proposition:** Does this function call React hooks (directly or through a
  `use*` function) while bearing a plain non-`use`, non-component name, so
  callers cannot tell the Rules of Hooks apply?
- **Evidence sketch:** Call graph over the changed span: function body
  containing `use*` calls (or calls into `use*`-named functions) whose own
  name is neither `use*` nor Capitalized-component-shaped; caller sites
  invoking it inside conditions/loops/nested closures corroborate.
  Abstain for Capitalized components and for functions merely receiving a
  hook result as an argument.
- **Uncertainty:** Experts split on whether an inner `use*`-named callee is
  a genuine hook (Rules apply transitively) or a plain helper that happens
  to share the prefix — that classification is the judgment. A regex sees
  the prefix but cannot resolve transitivity or component-shape intent.
- **Registry:** No overlap — verified no hook-contract rule exists
  (`hook` appears only in `jev/no-subclass-fragility-hook`, unrelated).

### 2. `jev/no-implementation-named-test`

- **Proposition:** Does this test's title name the implementation under test
  (function name, file, internal method) instead of stating the behavior and
  expected outcome, so a failure tells the reader where, not what broke?
- **Evidence sketch:** `describe`/`it`/`test` string literals in changed test
  files compared against the imported unit's identifiers and file stem;
  title that is just the function name (`it('getUser')`) is the signal,
  outcome-verb + condition (`rejects creation with missing field`) is the
  counter-signal. Title-body mismatch (claims X, asserts Y) strengthens.
- **Uncertainty:** Experts disagree on where a precise implementation
  reference ends and a behavior statement begins (e.g. is naming the endpoint
  plus the expected status behavior or implementation?). A regex can measure
  title↔identifier overlap but cannot judge whether an outcome is stated.
- **Registry:** No overlap — verified no test-title rule exists in registry.

### 3. `jev/no-mechanism-bound-name`

- **Proposition:** Does this function or variable name describe the mechanism
  or algorithm (how it works) rather than the caller's goal, so the name
  lies after any reimplementation?
- **Evidence sketch:** Changed declarations: name tokens naming mechanisms
  (`…ByLoop`, `…Hash`, `…WithRegex`) compared against body effects and
  sibling abstractions at the higher concept; a name that would have to
  change if the algorithm changed is the signal.
- **Uncertainty:** The "would this name survive reimplementation" test is
  genuine expert-disagreement territory — one reviewer's mechanism is
  another's domain concept (is `Hash` mechanism or the promised contract?).
  A regex can flag mechanism tokens but cannot place the name at the right
  abstraction level.
- **Registry:** Sibling, not duplicate — `jev/no-mysterious-name`
  (verified canonical) covers vague placeholders; this is the converse
  (specific but bound to the wrong level). Builders: read that spec first
  to hold the boundary.

### 4. `jev/no-stuttering-scope-name`

- **Proposition:** Does this name repeat its enclosing scope's vocabulary —
  class, module, or package stem — so the qualified use site stutters
  (`config.configPath`) where the bare noun would do?
- **Evidence sketch:** Changed member/variable names tokenized against the
  enclosing class name, file stem, and package/module qualifier; qualified
  use sites (`obj.objThing`) in the diff corroborate. Abstain where the
  repetition disambiguates genuine siblings.
- **Uncertainty:** Experts split on disambiguating vs. stuttering — the same
  repetition that looks redundant to one reviewer carries needed precision
  for another when sibling concepts share a scope. A regex measures token
  overlap but cannot see the sibling scope that justifies it.
- **Registry:** No identifier-level overlap (systems-lane filename
  miscellany is the file-level cousin, different proposition).

### 5. `jev/no-standard-method-synonym`

- **Proposition:** Does this exported operation invent a synonym
  (`fetch`/`retrieve`/`load`/`getData`) for a standard-method concept the
  API surface already expresses with another verb, fragmenting one resource
  operation across two vocabularies?
- **Evidence sketch:** Exported function/method names grouped by resource
  stem repo-wide: two verbs on the same stem (`getUser` + `fetchUser`) is
  the signal. **Repo evidence is load-bearing** — a lone `fetch` with no
  `get` sibling is house style, not fragmentation.
- **Uncertainty:** Whether two verbs denote the same operation (true
  synonym) vs. distinct semantics (cache-vs-network, one-vs-many) is a
  judgment call experts make differently with the same diff. A regex
  clusters synonyms but cannot compare effects.
- **Registry:** Sibling specialization of verified canonical
  `jev/no-synonym-vocabulary` (one-word-per-concept) with a standard-method
  oracle (AIP-131/132/133/190). Builders: read that spec first; merge if
  reviewers find the boundary too thin.

### 6. `jev/no-content-free-nominal`

- **Proposition:** Does this introduced class or type name end in a
  content-free nominal (`Manager`, `Helper`, `Util(s)`, `Handler`,
  `Processor`, `Data`, `Info`) that promises no domain role while its
  members span unrelated responsibilities?
- **Evidence sketch:** Type/class declarations matched against the closed
  suffix list (mechanical pre-filter); member-method cohesion as Jev
  evidence — methods touching disjoint domains with no shared invariant is
  the signal, a genuinely narrow role behind the bland name is the
  counter-signal.
- **Uncertainty:** Teams legitimately disagree on `Handler`/`Service` and on
  when a bland name hides incoherence vs. marks harmless convention — the
  cohesion reading, not the suffix, is the judgment. A regex matches the
  suffix but cannot assess member cohesion.
- **Registry:** Distinct from verified module-level
  `jev/no-utility-module-grab-bag` / `jev/no-utils-grab-bag-growth` (both
  about *placement in* shared modules, not class/type *names*) and from
  `jev/no-mysterious-name` (vague placeholders generally). Builders: read
  all three specs first to hold the boundaries.

### 7. `jev/no-cardinality-lying-type`

- **Proposition:** Does this type name pluralize a non-collection (a `Users`
  that is one object) — or singularize an array — misleading readers about
  cardinality at every use site?
- **Evidence sketch:** `type`/`interface` declarations: plural morphology
  (`-s`/`-es`/`-ies`, irregulars) checked against declared shape
  (array/tuple/`Set`/`Map`/`Record` vs. object/union). Abstain on domain
  plurals the codebase already treats as singular concepts (`News`,
  established `Settings` bags).
- **Uncertainty:** Small but real — unions-of-members read as "many", and
  codebase-accepted `Settings`-style bags divide experts on convention vs.
  lie. A regex compares morphology to shape but cannot grant the
  convention exemption.
- **Registry:** Neighbor, not duplicate — verified
  `jev/no-english-only-pluralization` covers locale-assuming plural
  *logic*; this is about *names* promising cardinality.

### 8. `jev/no-far-traveling-terse-name`

- **Proposition:** Does a terse name (single letter or terse abbreviation)
  survive beyond the few-line scope its brevity is justified by — exported,
  captured across a wide closure, or used far from its declaration — forcing
  distant readers to re-derive its meaning?
- **Evidence sketch:** Changed bindings with terse names:
  declaration-to-last-use distance, export status, closure-capture depth
  (all mechanical); canonical loop-index/one-liner positions abstain
  mechanically. Jev weighs the middle (a 30-line `d` threading branches vs.
  a harmless two-line `catch` binding).
- **Uncertainty:** Distance thresholds are the most taste-adjacent judgment
  on this list after #9 — experts set "too far" differently, which is
  exactly what a 0..1 score (not a cutoff) is for. A regex measures
  distance but cannot weigh capture complexity or reader burden.
- **Registry:** Distinct angle from verified `jev/no-cryptic-abbreviation`
  (*what* the short name means); this is *scope-lifetime* (even a clear
  abbreviation fails if it travels too far).

### 9. `jev/no-verb-named-field`

- **Proposition:** Does this stored type field or property use a verb or
  action phrase implying computation, where the member is plain stored state
  with no such behavior?
- **Evidence sketch:** `interface`/`type` fields and class properties with
  verb-first morphology, checked against member type: verb-named
  non-function-typed members are the signal; verb-named function-typed
  fields (thunks/callbacks like `onSubmit`, `fetchMore`) and `is/has/can`
  predicates abstain mechanically.
- **Uncertainty:** Real predicates and event-callback nouns blur the line
  (is `update` a stored callback or a lying verb?), and per-hit review
  value is modest — hence the tail slot. A regex flags verb morphology but
  cannot separate genuine callback nouns from state masquerading as action.
- **Registry:** Covers the verb-form/data-shape mismatch targeted by
  neither verified `jev/no-deceptive-name` nor
  `jev/no-predicate-name-deception`. Builders: read both specs first.

---

## Cut list

- **Inverted `on*`/`handle*` event contract (candidate 10) — CUT.**
  Deterministic-decidable: the proposition collapses to prefix shape
  (`on*` prop vs. `handle*` local) in the common case, and ownership
  usually resolves structurally via props-destructuring + invocation
  sites, leaving too thin a residue of expert disagreement for a
  probabilistic judgment. Revisit only if misdirected handler props show
  up as an observed agent failure mode with non-structural evidence.
- **Scout's 14 rejected — endorsed, not re-litigated:** casing conventions;
  `Get`-less getters / `is`-booleans / `-er` interfaces / UPPER_SNAKE
  constants; Hungarian notation; package/module lowercase; file-basename
  match; `should`-prefixed test titles; pun/one-word-per-concept (covered:
  `jev/no-punned-name`, `jev/no-synonym-vocabulary` — both verified);
  near-miss disinformation names (covered: verified
  `jev/no-same-stem-divergent-role`); pronounceable/searchable/single-letter
  (covered: verified `jev/no-cryptic-abbreviation`,
  `jev/no-mysterious-name`); negative booleans (covered: verified
  `jev/no-negative-boolean-name`); lying predicates (covered: verified
  `jev/no-predicate-name-deception`); verbless functions (covered: verified
  `jev/no-verbless-function-name`); DHH omakase residue folded into #3;
  AIP resource pluralization folded into #5/#7. Spot-verified the
  "covered" claims against the registry; the "regex-decidable" verdicts
  stand on their own.

---

## Build order

No sibling naming-rule builders exist yet — all 9 entries are independent
(no rule depends on another's output), so build strictly strongest-first:
1 → 9. Practical sequencing: batch A (#1–#3, strongest oracles, highest
signal per effort), batch B (#4–#6, medium — #5/#6 must be read against
their canonical siblings first), batch C (#7–#9, medium-weak — tail risk
is low hit-value, not incorrectness). Each entry is self-contained; no
cross-entry dependency gates anything.
