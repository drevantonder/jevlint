# Naming rule ideas (spec only — no implementation)

Mined from public naming standards and style guides: Beck / Clean Code
naming content, Go naming conventions (Effective Go, Uber guide, package-names
blog), Google AIP API naming, React hook/event naming rules, Pocock type-naming
tips, and unit-test naming standards. Public sources only.

Lane note: sibling threads covered general JS/TS standards and systems/infra
standards; this file is NAMING ONLY — functions, classes, files, variables,
types, and API surface. jevlint scores ONE uncertain proposition 0..1 per
judgment, never pass/fail. Rank by: falsifiable + gatherable evidence +
genuine uncertainty (an expert could disagree; a regex could not decide).
Deterministic-decidable = oxlint territory, CUT.

Convention per candidate: source + link, the standard in one line, a proposed
jevlint proposition in falsifiable question form, an evidence sketch (what the
rule would inspect), a strength rank, and an overlap note against the existing
~300-key registry (dedup doctrine: where a canonical `jev/no-*` id already
covers the ground, cite it instead of proposing a duplicate). **Strong** =
checkable statically with a clear oracle. **Weak** = taste/vibes (marked
honestly). Ranked strong → weak. Duplicates across sources merged with both
citations.

---

## 1. Hook-using function hiding without the `use` prefix (STRONG)

- **Sources:**
  - React docs, "Reusing Logic with Custom Hooks" — "Hook names must start
    with `use` followed by a capital letter … so that you can tell at a
    glance that the rules of Hooks apply to it."
    (https://react.dev/learn/reusing-logic-with-custom-hooks)
  - React docs, "Building Your Own Hooks" — "Its name should always start
    with `use` so that you can tell at a glance that the rules of Hooks
    apply to it."
    (https://legacy.reactjs.org/docs/hooks-custom.html)
  - React docs, "Rules of Hooks" — hooks only at top level of components and
    custom hooks; conditional/loop/nested calls break.
    (https://react.dev/reference/rules/rules-of-hooks)
- **Standard in one line:** Any function that calls hooks must advertise the
  hook contract — a `use*` name or a capitalized component name — so callers
  know the Rules of Hooks apply.
- **Proposition:** "Does this function call React hooks (directly or through
  a `use*` function) while bearing a plain non-`use`, non-component name, so
  callers cannot tell the Rules of Hooks apply to it?"
- **Evidence sketch:** Call graph over the changed span: function body
  containing `use*` calls (or calls into `use*`-named functions) whose own
  name does not start with `use` and is not Capitalized-component-shaped;
  caller sites invoking it inside conditions/loops/nested closures are
  corroborating evidence. Abstain for Capitalized components (contract is
  visible) and for functions that merely receive a hook result as an
  argument.
- **Strength:** Strong. The `use*`-call-inside-non-`use`-name shape is
  statically enumerable; the only judgment is whether the inner call is a
  genuine hook vs. a `use*`-named plain helper — a small, well-scoped oracle.
- **Overlap:** None in registry (no hook-contract rule exists). Closest
  neighbors (`jev/no-hidden-io`, `jev/no-query-side-effect`) are about
  effects, not the hook naming contract.

## 2. Test title names the implementation instead of the behavior (MEDIUM-STRONG)

- **Sources:**
  - Roy Osherove via Quality Coding, "Unit Test Naming: The 3 Most Important
    Parts" — a failing-test title must say what operation, under what
    circumstances, with what expected result:
    `UnitOfWork_StateUnderTest_ExpectedBehavior`.
    (https://qualitycoding.org/unit-test-naming/)
  - skillstack `test-structure-guide.md` — "Specific, describes behavior …
    Formula: `should [action] [context/condition]`"; vague `it('works')` /
    `it('test 1')` called out as WRONG.
    (https://github.com/viktorbezdek/skillstack/blob/main/test-driven-development/skills/test-driven-development/references/test-structure-guide.md)
  - TrigenSoftware `skills/unit-tests/SKILL.md` — describe groups mirror the
    unit's address; titles carry the behavior claim.
    (https://github.com/TrigenSoftware/scripts/blob/main/skills/unit-tests/SKILL.md)
- **Standard in one line:** A test title states the behavior and expected
  outcome under conditions — never the name of the function/file under test.
- **Proposition:** "Does this test's title name the implementation under
  test (function name, file, internal method) instead of stating the
  behavior and expected outcome, so a failure tells the reader where, not
  what broke?"
- **Evidence sketch:** `describe`/`it`/`test` string literals in changed test
  files, compared against the imported unit's identifiers and file stem:
  title that is just the function name (`it('getUser')`) or a bare
  re-statement of the describe is the signal; title containing an outcome
  verb + condition (`rejects creation with missing field`) is the
  counter-signal. Pair with the body: title-behavior mismatch (title claims
  X, body asserts Y) strengthens the judgment.
- **Strength:** Medium-strong. Title-vs-identifier overlap is mechanical;
  whether the title states an outcome needs Jev, but the oracle (Osherove's
  three parts) is crisp.
- **Overlap:** None in registry (test rules cover assertions, mocks, and
  isolation — not title content).

## 3. Mechanism-bound name instead of an intent-revealing one (MEDIUM-STRONG)

- **Sources:**
  - Kent Beck, Smalltalk Best Practice Patterns via XUnitPatterns "Intent
    Revealing Name" — "Name your methods (and variables) based on the intent
    of the user … Describe the goal they would seek to fulfil, not the
    mechanism or algorithm used to fulfil it" (paraphrased from Beck).
    (http://gerardmeszaros.com/Intent%20Revealing%20Name.html)
  - Martin Fowler, "Beck Design Rules" — code "Reveals intention …
    Communication is a core value."
    (https://martinfowler.com/bliki/BeckDesignRules.html)
  - Robert C. Martin, Clean Code ch. 2, "Use Intention-Revealing Names."
    (https://www.oreilly.com/library/view/clean-code-a/9780136083238/chapter02.xhtml)
  - DHH, Rails Doctrine "conceptual compression" — good names compress the
    mechanism away so callers think at the higher concept.
    (https://rubyonrails.org/doctrine)
- **Standard in one line:** Names state the caller's goal (what), never the
  algorithm or mechanism (how) — a rename should survive an implementation
  change.
- **Proposition:** "Does this function or variable name describe the
  mechanism or algorithm (how it works: loop shape, data structure,
  protocol step) rather than the caller's goal, so the name lies after any
  reimplementation?"
- **Evidence sketch:** Changed declarations: name tokens naming mechanisms
  (`…ByLoop`, `…Hash`, `…Manual`, `…WithRegex`, `jsonString…` for what is
  really serialization policy) compared against body effects and against
  sibling abstractions at the higher concept; a name that would have to
  change if the algorithm changed is the signal.
- **Strength:** Medium-strong. Mechanism-token detection is a mechanical
  pre-filter; "would this name survive reimplementation" is genuine expert
  disagreement territory — exactly Jev-shaped.
- **Overlap:** Adjacent to `jev/no-mysterious-name` (canonical for vague
  placeholders) — this is the distinct converse: the name is *specific but
  bound to the wrong level*. Cite `no-mysterious-name` as the sibling, not
  a duplicate.

## 4. Gratuitous context / stuttering qualifier (MEDIUM)

- **Sources:**
  - Robert C. Martin, Clean Code ch. 2, "Don't Add Gratuitous Context" —
    `addrFirstName` inside class `Address`; trailing `Data`/`Info` noise that
    adds no distinction.
    (https://www.oreilly.com/library/view/clean-code-a/9780136083238/chapter02.xhtml)
  - Uber Go guide issue #112, "Proposal: Avoid stuttering in naming."
    (https://github.com/uber-go/guide/issues/112)
  - Go blog, "Package names" — good names don't stutter at the use site
    (`http.Server`, not `http.HTTPServer`).
    (https://go.dev/blog/package-names)
  - Go "What's in a name?" talk slides — "Avoid redundant names, given their
    context: Prefer `count` to `runeCount` inside a function named
    `RuneCount`."
    (https://go.dev/talks/2014/names.slide)
- **Standard in one line:** A name never repeats context its scope already
  provides — no enclosing-class/module/package stem smuggled into the
  member name.
- **Proposition:** "Does this name repeat its enclosing scope's vocabulary —
  class, module, or package stem — so the qualified use site stutters
  (`config.configPath`, `address.addrCity`) where the bare noun would do?"
- **Evidence sketch:** Changed member/variable names tokenized and compared
  against the enclosing class name, file stem, and (for re-exported APIs)
  package/module qualifier; qualified use sites (`obj.objThing`) in the
  diff are corroborating evidence. Abstain where the repetition
  disambiguates genuine siblings (two `config` concepts in one scope).
- **Strength:** Medium. Token-overlap with the enclosing scope is
  mechanical; "disambiguating vs. stuttering" needs Jev and the sibling
  scope as evidence.
- **Overlap:** None direct. Systems-lane file-miscellany candidate (misc
  filenames) is the file-level cousin; this is identifier-level.

## 5. Standard-method synonym fragmenting the API vocabulary (MEDIUM)

- **Sources:**
  - Google AIPs: AIP-131 (`Get`), AIP-132 (`List`), AIP-133 (`Create`) —
    standard methods with fixed names; "APIs must provide a get method for
    resources."
    (https://google.aip.dev/131) (https://google.aip.dev/132)
  - AIP-190, "Method names … `VerbNoun` in UpperCamelCase, where the noun is
    typically the resource type"; standard methods define their own naming.
    (https://google.aip.dev/190)
  - Google Cloud API design guide — resource-oriented design with a small,
    consistent verb vocabulary.
    (https://docs.cloud.google.com/apis/design)
- **Standard in one line:** One concept, one standard verb — `Get`/`List`/
  `Create`/`Update`/`Delete`, never `fetch`/`retrieve`/`getData` synonyms
  for the same resource operation.
- **Proposition:** "Does this exported operation invent a synonym
  (`fetch`/`retrieve`/`load`/`getData`) for a standard-method concept the
  API surface already expresses with another verb, fragmenting one resource
  operation across two vocabularies?"
- **Evidence sketch:** Exported function/method names grouped by resource
  stem across the repo: two verbs on the same stem (`getUser` + `fetchUser`,
  `listOrders` + `loadOrders`) is the signal; **repo evidence is
  load-bearing** — a lone `fetch` with no `get` sibling is a house style,
  not fragmentation. TS reshaping: AIP's `VerbNoun` UpperCamel maps to
  `verbNoun` lowerCamel exports.
- **Strength:** Medium. Synonym clustering is countable; whether the two
  verbs really denote the same operation (vs. cache-vs-network, one-vs-many)
  is the genuine uncertainty.
- **Overlap:** Cite `jev/no-synonym-vocabulary` (canonical for one-word-per-
  concept duplication) — this is its API-surface specialization with a
  standard-method oracle; propose as sibling, merge if reviewers prefer.

## 6. Content-free class nominal (`Manager`/`Helper`/`Util`) (MEDIUM)

- **Sources:**
  - Robert C. Martin, Clean Code ch. 2, "Class Names … should be nouns …
    Avoid … `Manager`, `Processor`, `Data`, `Info`"-style words that promise
    no role.
    (https://www.oreilly.com/library/view/clean-code-a/9780136083238/chapter02.xhtml)
  - samber `golang-naming` skill — `utils`/`helpers` called out as
    anti-patterns.
    (https://github.com/samber/cc-skills-golang/blob/main/skills/golang-naming/SKILL.md)
  - Cygnus Dynamics Go coding standards, naming tables — role-bearing type
    names (`OrderService`, `PaymentProcessor`) as the positive form.
    (https://docs.cygnusdynamics.com/golang/naming/)
- **Standard in one line:** Class/type names are domain nouns that promise a
  role — never `Manager`, `Helper`, `Util`, `Processor`, `Data`, `Info`
  suffixes that hide low cohesion.
- **Proposition:** "Does this introduced class or type name end in a
  content-free nominal (`Manager`, `Helper`, `Util(s)`, `Handler`,
  `Processor`, `Data`, `Info`) that promises no domain role while its
  members span unrelated responsibilities?"
- **Evidence sketch:** Type/class declarations in the changed span matched
  against the nominal-suffix list (mechanical pre-filter); member-method
  cohesion as Jev evidence — methods touching disjoint domains with no
  shared invariant is the signal; a genuinely narrow role behind the bland
  name (one-method coordinator with a real invariant) is the counter-signal.
- **Strength:** Medium. The suffix list is exact; "bland name hiding real
  incoherence vs. harmless convention" is judgment, and teams legitimately
  disagree on `Handler`/`Service`.
- **Overlap:** Cite `jev/no-mysterious-name` (canonical for vague names) —
  this is its class-nominal specialization with a closed suffix oracle.

## 7. Type-name cardinality lie (pluralized non-collection) (MEDIUM-WEAK)

- **Sources:**
  - Matt Pocock, "How to Name your Types" — "Never pluralize: Unless your
    type is an array type, you should make it singular — even if it's a
    union of members"; plus casing separation between values and types.
    (https://www.totaltypescript.com/tips/how-to-name-your-types)
- **Standard in one line:** Type names are singular unless the type is a
  collection — a plural name promises cardinality the shape doesn't deliver.
- **Proposition:** "Does this type name pluralize a non-collection (a
  `Users` that is one object, an `Options` that is one bag) — or singularize
  an array — misleading readers about cardinality at every use site?"
- **Evidence sketch:** `type`/`interface` declarations in the changed span:
  plural morphology (`-s`/`-es`/`-ies`, irregulars) checked against the
  declared shape (array/tuple/`Set`/`Map`/`Record` vs. object/union);
  singular name on an array alias is the mirror signal. Abstain on domain
  plurals that are genuinely singular concepts (`News`, `Settings` bags the
  codebase already treats as one).
- **Strength:** Medium-weak. Morphology-vs-shape is near-mechanical; the
  residue (union-of-members read as "many", codebase-accepted `Settings`)
  is small but real judgment.
- **Overlap:** Adjacent to `jev/no-english-only-pluralization` (canonical
  for locale-assuming plural *logic*) — this is about *names* promising
  cardinality, a different proposition; cite as neighbor.

## 8. Terse name outliving the scope its brevity is justified by (MEDIUM-WEAK)

- **Sources:**
  - Go "What's in a name?" talk slides — "Local variables: Keep them short
    … Prefer `i` to `index`. Prefer `r` to `reader`" — *local* being the
    operative scope limit.
    (https://go.dev/talks/2014/names.slide)
  - Effective Go, "Names" — short names are for short scopes; "the greater
    the distance between a declaration and its use, the longer the name
    should be" (in spirit throughout the naming section).
    (https://go.dev/doc/effective_go)
  - Robert C. Martin, Clean Code ch. 2, "Use Searchable Names" + "Avoid
    Mental Mapping" — single letters force readers to map `r` → URL.
    (https://www.cs.hmc.edu/cs70/homework/homework-03/pdfs/stylemartin.pdf)
- **Standard in one line:** Name length grows with scope distance — terse
  names are for loop-locals, never for exports, wide closures, or
  far-captured bindings.
- **Proposition:** "Does a terse name (single letter or terse abbreviation)
  survive beyond the few-line scope its brevity is justified by — exported,
  captured across a wide closure, or used far from its declaration — forcing
  every distant reader to re-derive its meaning?"
- **Evidence sketch:** Changed bindings with terse names: declaration-to-
  last-use line distance, export status, and closure-capture depth are all
  mechanical; canonical loop-index positions (`for (let i …)`, `arr.map(x
  => …)` one-liners) abstain mechanically. Jev weighs the middle: a 30-line
  `d` threading through branches vs. a harmless `e` in a two-line catch.
- **Strength:** Medium-weak. Distance + export + capture are countable, but
  thresholds are taste-adjacent; expect the most legitimate disagreement on
  this list after candidate 10.
- **Overlap:** Cite `jev/no-cryptic-abbreviation` (canonical for *what* the
  short name means) — this is the distinct *scope-lifetime* angle: even a
  clear abbreviation fails if it travels too far.

## 9. Verb-named stored field implying action where there is state (MEDIUM-WEAK)

- **Sources:**
  - AIP-140, "Field names … must not be named to reflect an intent or
    action. They must not be verbs … the name must be a noun. It defines
    what is so, not what to do."
    (https://google.aip.dev/140)
  - Robert C. Martin, Clean Code ch. 2, "Use Appropriate Parts of Speech"
    (2024 "Clean Code" update TOC: class names nouns, method names verbs).
    (https://ptgmedia.pearsoncmg.com/images/9780135398579/samplepages/9780135398579_Sample.pdf)
- **Standard in one line:** Stored fields are nouns (what is so); verbs are
  for functions (what to do) — a verb-named field promises computation that
  isn't there, or hides it where callers don't expect it.
- **Proposition:** "Does this stored type field or property use a verb or
  action phrase (`fetchUsers`, `isLoadingMore…` excluded — genuine
  predicates aside) implying computation, where the member is plain stored
  state with no such behavior?"
- **Evidence sketch:** `interface`/`type` field and class property names in
  the changed span with verb-first morphology, checked against the member
  type: verb-named non-function-typed members are the signal; verb-named
  *function-typed* fields (thunks/callbacks — `onSubmit`, `fetchMore`) and
  `is/has/can` predicates abstain mechanically.
- **Strength:** Medium-weak. Verb morphology + non-function type is a crisp
  pre-filter, but real predicates and event-callback nouns blur the line —
  and the review value per hit is modest.
- **Overlap:** Cite `jev/no-deceptive-name` (canonical for names whose
  meaning misleads) and `jev/no-predicate-name-deception` (canonical for
  lying predicates) — this covers the remaining verb-form/data-shape
  mismatch neither sibling targets.

## 10. Inverted `on*`/`handle*` event contract (WEAK)

- **Sources:**
  - React docs, "Responding to Events" — local function `handleClick`
    passed to the `onClick` prop: `handle*` is the implementation,
    `on*` is the prop contract.
    (https://react.dev/learn/responding-to-events)
  - Engineered.at, "Event Handler Naming in React" — `on*` for prop names,
    `handle*` for the corresponding functions; noun-then-verb ordering in
    compounds.
    (https://engineered.at/articles/event-handler-naming-in-react)
  - Jimmy Sweeney, "Event Handler Naming Conventions" — `onClick` gets the
    prop name when the handler is passed in from above.
    (https://jimmysweeney.page/blog/event-handler-naming-conventions/)
- **Standard in one line:** `on*` names the prop (the event contract);
  `handle*` names the local function (the implementation) — never inverted.
- **Proposition:** "Does this component expose a callback prop without the
  `on*` prefix, or name a purely local handler `on*` (implying it is a
  parent-supplied prop), confusing who owns the event contract?"
- **Evidence sketch:** Changed JSX component definitions: props-destructured
  function-typed props not starting with `on` that are invoked as event
  callbacks are the signal; module-local `const onX = …` functions never
  passed down as props are the mirror signal. `on`/`handle` prefixing is
  near-mechanical — which is also this candidate's weakness (see rank).
- **Strength:** Weak. Honestly close to oxlint territory: the prefix check
  is a regex and the "who owns it" question usually resolves structurally.
  Kept at the tail because agents mixing prop/handler direction is a real,
  observed failure mode — but expect this to be the first cut if the bar
  tightens.
- **Overlap:** None in registry.

---

## Rejected (weakest cut)

Mined but failing the jevlint bar — deterministic-decidable (oxlint
territory, a regex could decide), already covered by a canonical rule, or no
falsifiable proposition:

- **Casing conventions** (PEP-8 CapWords/lowercase
  https://peps.python.org/pep-0008/; Java class/method/constant casing;
  Go MixedCaps https://go.dev/doc/effective_go; Pocock's values-vs-types
  casing tip). Pure shape checks — a regex decides; Jev scoring would add
  nothing. WEAKEST CUT: the clearest below-the-bar example, rejected first.
- **`Get`-less getters / `is`-prefixed booleans / `-er` interfaces / UPPER_SNAKE
  constants** (Effective Go getters, Uber "don't `Get`", JavaBean `is*`,
  Go `Stringer`/`Reader`). Same verdict: mechanical prefix/suffix checks.
- **Hungarian notation / `m_` encodings** (Clean Code "Avoid Encodings").
  Regex-decidable; also largely extinct in TS codebases agents write.
- **Package/module all-lowercase, no underscores** (Go package-names blog,
  PEP-8 modules). Filename/package-shape checks — linter territory.
- **File basename must match default export / component** (React/Next
  convention, Vessels "match existing patterns"). A basename comparison —
  below the Jev bar; kept out (distinct from kept candidate 4, which needs
  scope-vocabulary judgment, not string equality).
- **Test titles must start with `should`** (kaiord `test-conventions` spec,
  enforced by `scripts/check-test-title-should.mjs`). The source itself
  enforces it with a mechanical guard script — the strongest possible
  evidence it needs no probabilistic judgment. (Kept candidate 2 instead:
  *behavior-vs-implementation* content, which no regex can decide.)
- **"Don't pun" / one word per concept** (Clean Code). Covered — cite
  `jev/no-punned-name` and `jev/no-synonym-vocabulary`; no new proposition.
- **Disinformation via near-miss sibling names** (`AccountList` vs
  `AccountGroup`, Clean Code "Avoid Disinformation"). Covered — cite
  `jev/no-same-stem-divergent-role` (same stem, divergent role) as
  canonical; the residue is not a distinct proposition.
- **Pronounceable / searchable names, no single letters** (Clean Code).
  Covered — cite `jev/no-cryptic-abbreviation` and `jev/no-mysterious-name`;
  kept candidate 8 instead (the scope-lifetime angle neither covers).
- **Negative boolean names** (`noNotReady`). Covered — `jev/no-negative-
  boolean-name` is canonical.
- **Predicate names that lie** (`isReady` returning non-boolean / checking
  the wrong condition). Covered — `jev/no-predicate-name-deception` is
  canonical.
- **Verbless function names** (Clean Code method-names-are-verbs). Covered
  — `jev/no-verbless-function-name` is canonical.
- **DHH Majestic Monolith / omakase-as-naming** beyond candidate 3's
  citation. Framework-taste at repo scale; its checkable residue
  (name the concept, not the mechanism) folded into candidate 3.
- **AIP resource-name pluralization / collection naming**
  (https://google.aip.dev/190). For TS agent code the checkable residue
  collapses into candidate 5 (standard verbs) and candidate 7
  (cardinality); no third proposition survived.

## Method note

- Searched via web (public pages only, no auth): Beck intention-revealing
  (Meszaros/XUnitPatterns, Fowler bliki, InformIT Implementation Patterns);
  Clean Code ch. 2 headings (O'Reilly, Pearson sample, bmad-labs skill
  mirror); Uber Go guide + issue #112 stutter proposal; Go blog
  package-names; Go "What's in a name?" slides; Effective Go names;
  golang-naming skill (samber); Cygnus Go naming standards; Google AIP
  131/132/133/140/190 + Cloud API design guide; React docs custom hooks,
  rules-of-hooks, responding-to-events; engineered.at + Sweeney event
  naming; Pocock "How to Name your Types"; PEP-8 naming section;
  Osherove test naming via Quality Coding; skillstack test-structure
  guide; TrigenSoftware unit-tests skill; Rails Doctrine (DHH conceptual
  compression, cited in candidate 3).
- Registry overlap checked against `src/defaults.ts` (`jev/no-*` ids):
  `no-mysterious-name`, `no-verbless-function-name`, `no-deceptive-name`,
  `no-punned-name`, `no-cryptic-abbreviation`, `no-negative-boolean-name`,
  `no-predicate-name-deception`, `no-synonym-vocabulary`,
  `no-same-stem-divergent-role`, `no-shadowed-meaning`,
  `no-context-homonym-type`, `no-english-only-pluralization` — cited
  inline where adjacent; no candidate duplicates a canonical proposition.
- Zero live Jev calls. No implementation touched.
