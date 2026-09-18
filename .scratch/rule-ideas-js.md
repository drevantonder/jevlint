# JS/TS agent-coding rule ideas (spec only — no implementation)

Mined from public AGENTS.md / CODING_STANDARDS.md / skill repos of people who
code heavily with agents in the JS/TS world. Public sources only, fetched via
`curl` of GitHub raw / public pages; no auth, no private repos.

Convention per candidate: source + link, the standard in one line, a proposed
jevlint proposition in falsifiable question form, an evidence sketch (what the
rule would inspect), and a strength rank. **Strong** = checkable statically
with a clear oracle. **Weak** = taste/vibes (marked honestly). Ranked
strong → weak. Duplicates across sources are merged with both citations.

Scope note: a jevlint rule = falsifiable proposition + evidence scope that a
senior would check before judging; Jev scores ONE uncertain proposition 0..1,
never pass/fail.

---

## 1. Tautological test assertion (STRONG)

- **Sources:**
  - mattpocock/skills, `skills/engineering/tdd/SKILL.md` — "Tautological: the
    assertion recomputes the expected value the way the code does … Expected
    values must come from an independent source of truth: a known-good
    literal, a worked example, the spec."
    (https://github.com/mattpocock/skills/blob/main/skills/engineering/tdd/SKILL.md)
  - Same repo, `skills/engineering/tdd/tests.md` — BAD:
    `expect(add(a, b)).toBe(a + b)` / `items.reduce(...)` recomputed in the
    test; GOOD: known literal `toBe(15)`.
  - Changeset `.changeset/tdd-tautological-tests.md` — added as a peer
    anti-pattern distinct from implementation-coupling.
    (https://github.com/mattpocock/skills/blob/main/.changeset/tdd-tautological-tests.md)
- **Standard in one line:** Test expected values must come from an independent
  source of truth, never recomputed the way the implementation computes them.
- **Proposition:** "Does this test's assertion derive its expected value using
  the same computation as the code under test, so that it passes by
  construction and can never disagree with the code?"
- **Evidence sketch:** Test files (`*.test.ts(x)`, `__tests__/`) paired with
  the unit under test: compare the expression inside `expect(...)` /
  `assert.equal(actual, expected)` argument positions against the
  implementation's return expression — shared AST subexpression (same helper
  call, same reduce/map chain, constant asserted equal to itself) is the
  signal; a literal / fixture / spec-quoted value is the counter-signal.
- **Strength:** Strong. Syntactic overlap between "expected" and
  implementation is statically checkable; oracle is crisp (independent
  literal vs. recomputed derivation).

## 2. Test coupled to implementation internals (STRONG)

- **Sources:**
  - Kent C. Dodds, "Testing Implementation Details"
    (https://kentcdodds.com/blog/testing-implementation-details) — tests that
    assert on `state('openIndex')`, call `instance().setOpenIndex`, or find
    `AccordionContents` by component name give false negatives on refactor and
    false positives on breakage; definition: "implementation details are
    things which users of your code will not typically use, see, or even know
    about."
  - mattpocock/skills, `skills/engineering/tdd/tests.md` — BAD: testing
    private methods, asserting call counts/order; GOOD: verify through the
    interface (`getUser(user.id)` instead of a side-channel `db.query`).
    (https://github.com/mattpocock/skills/blob/main/skills/engineering/tdd/SKILL.md)
- **Standard in one line:** Tests verify behavior through public interfaces,
  never private methods, internal state, component internals, or side
  channels.
- **Proposition:** "Does this test observe or drive the unit through means no
  production caller uses — private methods, internal state, component-type
  queries, or a side-channel read — instead of its public interface?"
- **Evidence sketch:** Test files: imports of `*/internal*` paths, access to
  `private`/`#` members, enzyme-style `state()`/`instance()`/`find('Name')`,
  RTL `container.querySelector` reaching past roles/text users see, direct DB
  reads to verify what an API should return. Pair with the unit's exported
  surface to confirm the probed member is non-public.
- **Strength:** Strong. Non-public access and side-channel verification are
  statically enumerable; oracle (the public export surface) is explicit.

## 3. Mocking owned code instead of the system boundary (STRONG)

- **Sources:**
  - mattpocock/skills, `skills/engineering/tdd/mocking.md` — "Mock at system
    boundaries only: external APIs, databases, time/randomness, filesystem.
    Don't mock your own classes/modules, internal collaborators, anything you
    control." Plus design rules: dependency injection, SDK-style interfaces.
    (https://github.com/mattpocock/skills/blob/main/skills/engineering/tdd/SKILL.md)
  - Kent C. Dodds, "Write fewer, longer tests" — mocks only the network seam
    (`api.getCourseInfo`), everything else real.
    (https://kentcdodds.com/blog/write-fewer-longer-tests)
- **Standard in one line:** Mock only at system boundaries (external APIs,
  DB, time/random, fs); never mock modules you own.
- **Proposition:** "Does this test replace a module the repository itself
  owns and controls with a mock, rather than mocking at a genuine system
  boundary?"
- **Evidence sketch:** `jest.mock(...)` / `vi.mock(...)` targets resolved
  against the repo file tree: target inside the repo (own class/module,
  internal collaborator) is the signal; target resolving to `node_modules`,
  network clients, clock/random, or fs is the counter-signal.
- **Strength:** Strong. Mock target vs. repo-ownership is a path-resolution
  check with a bright line.

## 4. Unhandled floating promise (STRONG)

- **Sources:**
  - Matt Pocock, "What TypeScript-related ESLint rules could you not live
    without?" — `no-floating-promises`, `no-misused-promises`, `no-unsafe-*`,
    `no-explicit-any`, `consistent-type-imports` named as the must-haves.
    (https://www.linkedin.com/posts/mapocock_what-typescript-related-eslint-rules-could-activity-7165676975817248769-JRtm)
  - Vercel `vercel/vercel` AGENTS.md — `@typescript-eslint/no-unused-vars`
    enforced; test-hygiene rules as errors.
    (https://github.com/vercel/vercel/blob/main/AGENTS.md)
- **Standard in one line:** Every promise must be awaited, returned, or
  explicitly handled — never left floating.
- **Proposition:** "Does this change introduce a promise that is neither
  awaited, returned, nor given an explicit rejection handler, so failures
  vanish silently?"
- **Evidence sketch:** Expression statements / un-awaited call expressions
  whose type resolves to `Promise` (or `then`-able): check enclosing
  `await`/`return`/`.catch`/`void`-with-handler. Oxc candidate with a type
  oracle — closest to a deterministic pre-pass of anything on this list.
- **Strength:** Strong. Fully static with a type-aware oracle; the canonical
  Oxc-candidate shape.

## 5. `any` widening a public interface (MEDIUM-STRONG)

- **Sources:**
  - Matt Pocock, "`any` Considered Harmful, Except For These Cases" —
    "ban `any` from your codebase … turn on the ESLint rule … However, there
    are cases where `any` is needed" (generic constraints like
    `(...args: any[]) => any`, `as any` inside generic functions with a unit
    test as backstop; worth an `eslint-disable`).
    (https://www.totaltypescript.com/any-considered-harmful)
  - Epic Web principles, "Use Static Testing Tools" — "if you avoid `any`
    then you're even safer than the test can make you."
    (https://www.epicweb.dev/principles/craft/thinking-like-craftsperson/use-static-testing-tools)
- **Standard in one line:** `any` is banned by default; the only legitimate
  uses are inside generic machinery, each earning an explicit disable.
- **Proposition:** "Does this change expose `any` in a caller-visible
  position (parameter, return, exported type) where a narrower type was
  available, rather than confining `any` to generic internals?"
- **Evidence sketch:** `any` annotations / assertions in changed hunks,
  classified by position: exported signature positions are the signal;
  `(...args: any[]) => any`-style constraints and `as any` inside generic
  function bodies (with adjacent disable comment and/or unit test) are the
  documented exceptions forming the decision boundary.
- **Strength:** Medium-strong. `any` occurrences are trivially static; the
  judgment (legit-generic vs. lazy-widening) needs Jev, but the boundary
  cases are enumerated by the source itself.

## 6. Bare `JSON.parse` on untrusted input (MEDIUM-STRONG)

- **Sources:**
  - Vercel `vercel/ai` AGENTS.md — "Never use `JSON.parse` directly in
    production code … Instead use `parseJSON` or `safeParseJSON` from
    `@ai-sdk/provider-utils`."
    (https://github.com/vercel/ai/blob/main/AGENTS.md)
  - Epic Web principles, "Make assertions specific" — validation/parsing
    errors must carry what failed and why.
    (https://www.epicweb.dev/principles/testing-and-performance/make-assertions-specific)
- **Standard in one line:** Never bare-`JSON.parse` external data; parse
  through a safe/validating helper that surfaces failure.
- **Proposition:** "Does this production code path decode external or
  untrusted JSON with bare `JSON.parse` instead of a safe/validating parser,
  so malformed input throws an un-actionable error?"
- **Evidence sketch:** `JSON.parse(` call sites in non-test source; trace
  the argument toward network/response/file input vs. a local constant;
  confirm absence of try/catch-with-context, schema validation (zod), or a
  `safeParseJSON`-style wrapper at the site.
- **Strength:** Medium-strong. Call sites are static; "untrusted source" and
  "validating wrapper" need light judgment, both well-scoped.

## 7. Indiscriminable error (MEDIUM)

- **Sources:**
  - Vercel `vercel/ai` AGENTS.md — errors extend `AISDKError` with a
    `Symbol.for` marker and static `isInstance`, so callers can discriminate
    across realms/duplicated modules.
    (https://github.com/vercel/ai/blob/main/AGENTS.md)
  - Epic Web principles, "Make assertions specific" — errors must say what
    was intended and what fell short (`status`/`statusText`, not "request
    failed").
    (https://www.epicweb.dev/principles/testing-and-performance/make-assertions-specific)
- **Standard in one line:** Thrown errors must be programmatically
  discriminable (marker/subclass/code) and carry the specifics a catcher
  needs to act.
- **Proposition:** "Does this change throw or propagate an error that callers
  cannot discriminate or act on — a bare `Error` with a generic message, no
  code/marker/cause, where distinct failures need distinct handling?"
- **Evidence sketch:** `throw new Error(<literal>)` sites and rethrows in
  changed code; check for subclass/code/marker/`cause`/status fields and for
  catch sites that must branch on failure kind; conventional absence-lookups
  (`find` → `undefined`) are the counter-signal.
- **Strength:** Medium. Throw sites are static, but "caller needs to tell
  outcomes apart" is genuinely probabilistic — needs caller evidence, which
  is exactly the Jev-shaped part.

## 8. Generic conditional gateway instead of per-operation functions (MEDIUM)

- **Sources:**
  - mattpocock/skills, `skills/engineering/tdd/mocking.md` — "Prefer
    SDK-style interfaces over generic fetchers": per-endpoint functions are
    independently mockable; one `fetch(endpoint, options)` forces conditional
    logic inside every mock.
    (https://github.com/mattpocock/skills/blob/main/skills/engineering/tdd/SKILL.md)
- **Standard in one line:** One named function per external operation, not
  one generic `fetch(endpoint, …)` with conditional dispatch.
- **Proposition:** "Does this change route distinct external operations
  through a single generic gateway keyed by endpoint string or options flag,
  instead of exposing one named function per operation?"
- **Evidence sketch:** Functions taking `endpoint`/`url`/`path` strings (or
  method/action enums) with internal `if`/`switch` dispatch to different
  operations; test files with conditional mock bodies (`if url === …`) are
  corroborating evidence; per-operation named exports are the counter-signal.
- **Strength:** Medium. The gateway shape (stringly dispatch) is static; the
  judgment is whether the operations are truly distinct vs. one
  legitimately-parameterized call.

## 9. Overlay without an accessible title (MEDIUM)

- **Sources:**
  - shadcn/ui skill, `skills/shadcn/SKILL.md` + `rules/composition.md` —
    "Dialog, Sheet, and Drawer always need a Title … required for
    accessibility. Use `className=\"sr-only\"` if visually hidden."
    (https://github.com/shadcn-ui/ui/blob/main/skills/shadcn/SKILL.md)
- **Standard in one line:** Every dialog/sheet/drawer ships an accessible
  title, visually hidden if necessary.
- **Proposition:** "Does this change render a dialog, sheet, or drawer
  without an accessible title component, leaving assistive technology with no
  name for the overlay?"
- **Evidence sketch:** JSX: `DialogContent`/`SheetContent`/`DrawerContent`
  (and `AlertDialog`) subtrees searched for a `*Title` sibling; `sr-only`
  title counts as present; confirm the component set comes from the repo's
  installed base (radix vs. base variants differ — see `base-vs-radix.md`).
- **Strength:** Medium. Very checkable given a known component library, but
  the oracle depends on resolving the project's dialog primitives —
  library-specific, not universal.

## 10. Raw palette colors instead of semantic tokens (MEDIUM-WEAK)

- **Sources:**
  - shadcn/ui skill, `rules/styling.md` — "Use semantic colors:
    `bg-primary`, `text-muted-foreground` — never raw values like
    `bg-blue-500`"; no manual `dark:` overrides; status colors via Badge
    variants or semantic tokens.
    (https://github.com/shadcn-ui/ui/blob/main/skills/shadcn/SKILL.md)
- **Standard in one line:** Colors come from semantic theme tokens, never raw
  palette values; dark mode falls out of tokens, never manual overrides.
- **Proposition:** "Does this change hard-code raw palette colors
  (`bg-blue-500`, `text-gray-600`) or manual `dark:` color overrides where a
  semantic theme token exists for the same role?"
- **Evidence sketch:** `className` string literals / `cn()` arguments scanned
  for palette-plus-shade patterns (`/(blue|gray|red|…)-(50|…|950)/`) and
  `dark:(bg|text)-` overrides; theme/token definitions and Badge-variant
  usage are the counter-signal.
- **Strength:** Medium-weak. Regex-checkable, but "a semantic token exists
  for this role" needs theme context, and one-off marketing surfaces make
  legitimate exceptions — noisy without repo-specific tuning.

## 11. Tests sharing mutable setup across cases (MEDIUM-WEAK)

- **Sources:**
  - Kent C. Dodds, "Write fewer, longer tests" — the anti-pattern: shared
    mutable `utils` across `it` blocks, `beforeAll` render, cross-test async
    leakage and `act` warnings; the fix is one isolated workflow per test, a
    single Arrange with as many Acts/Asserts as the workflow needs.
    (https://kentcdodds.com/blog/write-fewer-longer-tests)
  - Kent C. Dodds, "Test Isolation with React" (cited therein) — tests must
    not share mutable state.
- **Standard in one line:** Each test sets up its own isolated state; no
  mutable variables shared or assigned across test cases.
- **Proposition:** "Do tests in this file share mutable render output or
  setup state across cases — module/`describe`-scoped `let` assigned in one
  test or hook and read in another — instead of arranging isolated state per
  test?"
- **Evidence sketch:** Test files: outer-scope `let`/`var` assigned inside
  `beforeAll`/`beforeEach`/`it` and read in a different `it`; a single
  `render` in `beforeAll` feeding multiple assertions blocks; counter-signal
  is per-test arrange (render + mock setup inside each `test`).
- **Strength:** Medium-weak. The `let`-across-`it` shape is static, but
  whether the sharing actually couples outcomes (vs. immutable fixtures, safe
  builders like `buildCourse`) needs data-flow judgment; appetite for this
  varies by team, so expect legitimate disagreement.

---

## Rejected (weakest cut)

These came up repeatedly but fail the jevlint bar — no falsifiable code
proposition, no static oracle, or pure process/style:

- **"One assertion per test" / test length limits** (Kent's "write fewer,
  longer tests" strawman). Kent himself refutes it: long multi-assert tests
  following one user workflow are *good*. Assertion count is not a quality
  signal — rejected because the source's own conclusion kills the oracle.
- **Vertical slices / one-seam-per-cycle / red-before-green** (pocock `tdd`
  skill "Rules of the loop", `to-spec" "fewest seams" guidance). Process
  discipline visible only across a work session, not in a diff — nothing for
  a candidate+evidence rule to grip.
- **Deep modules / depth-as-leverage vocabulary** (pocock `codebase-design`
  skill). Real design wisdom, but "is this interface deep?" has no static
  oracle a senior could agree on pre-judgment — vibes, however principled.
- **Fowler smell baseline as lint rules** (pocock `code-review` skill's
  Mysterious Name / Feature Envy / Shotgun Surgery list). The source itself
  labels every smell "always a judgement call, never a hard violation" — and
  several overlap existing jevlint territory (naming, coupling). Too soft and
  too duplicative.
- **Tailwind micro-style rules** (`space-x` → `gap`, `size-*`, `truncate`,
  `cn()` for conditionals — shadcn `styling.md`). Formatter/linter territory
  with zero uncertainty; Jev scoring would add nothing over oxlint.
- **Changesets-per-PR, conventional commits, prototype-marking** (Vercel
  monorepo AGENTS.md, pocock `prototype` skill). Repo-process compliance, not
  code propositions — out of jevlint's lane.

## Method note

- Fetched raw: `mattpocock/skills` (`tdd` SKILL + `tests.md` + `mocking.md`,
  `code-review`, `codebase-design`, `diagnosing-bugs`, `domain-modeling`,
  `prototype`, `to-spec`, `triage` SKILLs); `vercel/vercel`, `vercel/ai`,
  `vercel-labs/open-agents`, `vercel-labs/coding-agent-template` AGENTS.md
  files; `shadcn-ui/ui` shadcn skill (`SKILL.md`, `composition.md`,
  `styling.md`, `forms.md`, `icons.md`, `base-vs-radix.md`).
- Fetched readable: Kent C. Dodds "Testing Implementation Details" + "Write
  fewer, longer tests"; Epic Web "Testing & Performance" principles ("Make
  assertions specific", "Use Static Testing Tools"); Total TypeScript "`any`
  Considered Harmful" + "advice for security-critical TS apps".
- Theo / t3.gg material surveyed (create-t3-app docs, "I was wrong" / RSC
  retrospectives) but yielded positioning opinions (server-vs-client,
  full-stack typesafety) rather than statically-checkable standards, so it
  informs direction but produced no candidate above the bar — closest
  near-miss was "server-only code reachable from client components," cut as
  framework-version-sensitive.
