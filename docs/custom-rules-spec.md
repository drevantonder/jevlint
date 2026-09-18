# Custom rules — specification (spec only, no implementation)

## 0. Canon this spec follows

- jevlint scores ONE uncertain proposition 0..1 per judgment, never pass/fail
  (docs/adr/0001 — unchanged by this spec).
- Today projects cannot add rules: the registry is codegen-assembled from
  in-repo rule files only (`tools/generate-registry.mjs`); `defineConfig`
  shapes built-in selection only.
- User canon: copy oxlint's NORMAL custom-rule pattern (config registration by
  local path, custom rules same-shape-as-built-ins through the same pipeline)
  but NO eslint-compat layer — rule descriptors are native jevlint
  (proposition + evidence scope), not visitor objects.

Oxlint shape reference (copied where it fits, renamed where jevlint
vocabulary differs):

- Registration: `jsPlugins: ["./plugin.js"]` — paths resolved relative to the
  config file; rules then addressed as `<plugin-name>/<rule-name>` in `rules`.
  Plugin self-declares `meta.name`; config may alias on name clash.
- Plugin module: default-exports `{ meta: { name }, rules: { suffix: rule } }`.

## 1. Registration: `defineConfig` `plugins` entry

```ts
export default defineConfig({
  plugins: [{ name: "acme", specifier: "./jevlint-rules/todo-tickets.ts" }],
  rules: { "acme/no-todo-without-ticket": "off" }, // same mechanism as built-ins (§4)
});
```

- `plugins?: Array<{ name: string; specifier: string }>`; both fields required.
- `specifier`, v1: **local relative paths only** (`./…` or `../…`), resolved
  against the directory containing the config file (mirrors oxlint's
  relative-to-config resolution). Bare package specifiers (`eslint-plugin-foo`,
  `@foo/bar`) and absolute paths are **rejected at load** — decision: defer
  packages until free (§7, decision D1). Renamed `path` → `specifier` so the
  field survives if package resolution is ever added.
- `name`: authoritative namespace prefix for every rule the module provides.
  Must match `^[a-z0-9][a-z0-9-]*$`, must not be `jev`, must not contain `/`.
  The module MAY self-declare `name` (see §2); if it does and differs from the
  entry, load fails (prevents silent prefix mismatch). If the entry omits
  nothing — `name` is required (unlike oxlint's derivable meta.name), so a
  key's prefix is always visible at the registration site.
- Order: plugins load in entry order; entries are independent (no chaining).

## 2. Rule descriptor: minimal native shape

A plugin module is loaded with the same `jiti` importer as the config file
(`.ts`/`.js`/`.mjs`/`.cjs` all work). Its default export is either:

- (a) a single rule descriptor — `export default defineRule({...})`, or
- (b) a plugin container — `export default definePlugin({ name?, rules: { "<suffix>": defineRule({...}), … } })`.

Single-rule shorthand: the rule key suffix defaults to the file basename in
kebab-case (`todo-tickets.ts` → `no-todo-without-ticket` only if the descriptor
declares `name`; see key rule below — in practice authors use form (b) or set
`name` explicitly).

`defineRule` descriptor — exactly `RuleConfig` plus one function, nothing else:

```ts
defineRule({
  name: "no-todo-without-ticket",   // suffix; kebab-case, no `/`
  scope: "comment",                 // candidacy kind: 1 of the 5 CandidateKinds
  question: {                       // identical shape to RuleConfig.question
    instructions: { question, inspect?, focus?, decision_boundary? },
    criteria: { true: { what, remedy? }, false: { what } },
  },
  message: "TODO comment names no trackable ticket.",
  buildEvidence: (candidate, projectFiles, changes) => JsonValue | undefined,
});
```

Field-by-field justification:

- `scope` IS the candidacy kind (`comment | function | abstraction | change |
  module`). Dispatch filters `rule.scope !== candidate.kind` exactly as for
  bundled rules, so candidacy is identical by construction.
- `question` / `message` reuse the `RuleConfig` zod schema verbatim
  (`ruleConfigSchema` minus nothing) — the proposition flows into
  `EvaluationRequest` byte-for-byte like a built-in.
- `buildEvidence(candidate, projectFiles, changes)` mirrors the codegen
  contract (`tools/generate-registry.mjs`: params are a subset of the three,
  must include `candidate`, sync, returns `JsonValue | undefined`). At load the
  triple is passed positionally, so declaring fewer parameters just works
  (extra arguments ignored) — no arity introspection needed. `undefined`
  return = structural abstention (counted in `abstentions`, never a
  probability). A returned value flows through `compactEvidence`,
  per-candidate `evidence[ruleId]`, batching, omission ledger, and `coverage`
  identically to bundled rules — custom is never second-class in the report.
- Evidence-scope needs: the ONLY scopes a custom rule may ask for are the five
  `CandidateKinds` and the ONLY inputs its builder receives are the standard
  triple. No new candidacy kinds, no cross-cutting scopes, no host
  capabilities (no fs/network handles passed in). Anything broader is a load
  error (§6, "asking for the moon").
- `defineRule` / `definePlugin` are thin identity helpers (type-checking +
  documentation), exported from `jevlint` config surface alongside
  `defineConfig`. Nominal typing only; they must not wrap or alter the
  descriptor.

Validation at load (zod, same style as `userConfigSchema`):

- `name`: `^[a-z0-9][a-z0-9-]+$`, no `/`, must not start with `jev`.
- `scope`: enum of the five kinds.
- `question`/`message`: existing `ruleConfigSchema` shapes.
- `buildEvidence`: `typeof === "function"` and not an `AsyncFunction`
  (sync enforced at load; a thenable returned at review time is an evaluation
  failure, §6).

## 3. Key namespacing

- Full key = `<entryName>/<suffix>` (e.g. `acme/no-todo-without-ticket`).
  Prefix comes from the **config entry** (`plugins[].name`), never from the
  descriptor alone — decision D2.
- `jev/` is reserved for the codegen registry. Any custom key starting with
  `jev/` is rejected at load, even if no bundled rule currently holds it
  (prevents squatting future built-ins).
- Collisions: two entries with the same `name`, or two rules resolving to the
  same full key, are load errors naming both specifiers (§6). A custom key can
  never collide with a bundled key (prefix guard makes it structural), and
  custom-vs-custom collision across different prefixes is impossible by
  construction — the only collision surface is duplicate registration, which
  fails loudly.

## 4. Selection: same mechanism as built-ins, extended not duplicated

Current semantics (`mergeConfig`): `rules` record maps id → `"off"` (delete)
or full `RuleConfig` (set/override), merged over `defaultConfig.rules`.
Extended:

- Plugin-provided rules merge into the map as **enabled by default**, in
  plugin entry order after bundled defaults — uniform with built-ins (no
  parallel enable-list; decision D3).
- `"off"` on a custom key removes it — identical to built-ins.
- A full `RuleConfig` value on a custom key reshapes `scope`/`question`/
  `message` only; the plugin's `buildEvidence` is retained (evidence stays
  attached to the key, proposition text stays user-overridable — same split
  as bundled rules, whose builders live in-repo while their text is
  config-overridable).
- Hardening (flagged behavior change): a `rules` key that matches NEITHER a
  bundled id NOR a plugin-provided key is a load error (today it is silently
  accepted and judged evidence-free). Rationale: typo-safety; with custom keys
  in play, silent acceptance would hide misspelled prefixes. Unknown-key error
  lists the nearest known keys.

## 5. Loading: config-load merge, no codegen change — decision D4

- The codegen registry (`tools/generate-registry.mjs`, `src/evidence/index.ts`,
  freshness gate) stays **bundled-only** and untouched. It scans
  `src/evidence/`; project-local files are outside its world and must never
  leak into it.
- Custom rules merge at `loadConfig` time: plugin modules import via the
  existing `jiti` path, descriptors validate (§2), and the result carries the
  builders alongside the merged `rules` map. Concretely: `JevLintConfig` gains
  an optional load-time-only field, e.g.
  `customEvidence?: Record<ruleKey, CustomEvidenceBuilder>` (functions, never
  serialized — the report carries only evidence values, never builders).
- Dispatch (`buildRuleEvidence`, `prepareQuestions`, audit path): consult the
  custom map for keys the static registry does not hold (miss in BOTH maps =
  extracted-only/unknown handling exactly as today). No global registry
  mutation — the map threads explicitly from loaded config through analysis
  inputs, so concurrent reviews with different configs cannot cross-talk.
- Why not codegen: codegen is a repo-build-time, checked-in-glued step with a
  freshness gate; project rules exist only at user-review time. Merging at
  load keeps `pnpm check` semantics unchanged and custom rules out of
  `test/config.test.ts` / `test/extracted-rules.test.ts` generated blocks.

## 6. Failure modes — exact errors (exit 2, plain language)

All config/plugin load failures exit **2** (precedent: missing-credential exit
2 in `src/cli.ts`) via `stderr`, prefixed `jevlint: `, one line each, paths
rendered **relative to the project root** (never absolute, never home-dir —
no path leakage beyond the project). Never silent: any failure aborts before
evaluation; a review with an unloaded plugin never runs.

| # | Condition | Message (exact) |
|---|-----------|-----------------|
| E1 | specifier not found | `jevlint: plugin "acme" not found at <relpath> (relative to <relconfig>).` |
| E2 | specifier escapes project root, is absolute, or is a bare package | `jevlint: plugin "acme" specifier must be a project-local relative path, got "<specifier>".` |
| E3 | entry `name` invalid or `jev` | `jevlint: plugin name "<name>" is reserved or invalid (lowercase letters, digits, hyphens; not "jev").` |
| E4 | descriptor shape invalid (zod) | `jevlint: plugin "acme" rule "<suffix or ?>": <first-zod-issue-in-plain-words> (in <relpath>).` |
| E5 | module `name` differs from entry `name` | `jevlint: plugin at <relpath> declares name "<a>" but is registered as "<b>".` |
| E6 | duplicate plugin `name` / duplicate full key | `jevlint: duplicate custom rule "<key>" from <relpath-a> and <relpath-b>.` |
| E7 | custom key squats `jev/` | `jevlint: custom rule key "<key>" is reserved (jev/ is bundled-only).` |
| E8 | `scope` outside the five kinds ("moon") | `jevlint: plugin "acme" rule "<suffix>": scope must be one of comment, function, abstraction, change, module.` (subsumed by E4 in practice; listed so scope-requests are never silently coerced) |
| E9 | `buildEvidence` async or not a function | `jevlint: plugin "acme" rule "<suffix>": evidence builder must be a synchronous function.` |
| E10 | `rules` key matches nothing known | `jevlint: unknown rule "<key>". Did you mean "<closest>"?` |
| E11 | builder throws at review time | evaluation failure for those questions (no probability, review incomplete) — same as evaluator errors; message capped like `FAILURE_MESSAGE_LIMIT`, never the plugin's raw stack. |
| E12 | builder returns thenable or non-JSON at review time | evaluation failure (same treatment as E11); `undefined` remains the ONLY abstention signal. |

Ordering: E1–E3 (registration) → E4/E8/E9 (descriptor) → E5–E7 (namespacing) →
E10 (selection) — first failure aborts; reports all issues found within the
current stage where cheap (descriptor issues per rule), else first error wins.

## 7. Explicit non-goals

- **No eslint-compat**: no visitor objects, no `create(context)`, no
  `context.report`, no running existing eslint plugins. (Oxlint's compat layer
  is the pattern explicitly NOT copied.)
- **No severity levels**: custom rules emit probabilities only; no
  error/warn/off severity, no impact on the no-pass/fail contract (ADR-0001).
- **No threshold/cutoff knobs on custom rules**: display filtering (`minScore`,
  `limit`) stays global and post-hoc; per-rule cutoffs would smuggle pass/fail
  back in.
- **No package specifiers in v1** (decision D1 below); no versioning,
  no signature verification, no sandboxing of builders (they run as project
  code via `jiti`, same trust as `jevlint.config.ts` itself).

## Decisions

- **D1 — local-path-first, packages deferred**: v1 accepts only project-local
  relative specifiers. Why: package resolution adds versioning, cache, and
  supply-chain semantics that are free for oxlint (npm ecosystem exists) but
  unfree here; local paths keep every failure mode a one-line E1/E2.
- **D2 — prefix from config entry, not descriptor**: the key namespace is
  visible at the registration site and aliasing falls out for free (two
  entries, different names, same file). Why: mirrors oxlint's alias escape
  hatch while making squatting structurally impossible.
- **D3 — enabled-by-default + `off`, no parallel enable-list**: custom rules
  join the single `rules` merge. Why: one selection mechanism means the
  omission ledger, `unscoredRules`, and coverage count custom rules with zero
  special-casing — the "never second-class" requirement.
- **D4 — load-time merge, no codegen change**: registry stays bundled-only.
  Why: codegen is repo-build-time with a checked-in freshness gate; project
  rules are review-time data. Keeps `pnpm check` and generated test blocks
  untouched.
- **D5 — unknown `rules` keys become errors (E10)**: behavior change flagged.
  Why: with two key namespaces, silent acceptance turns typos into
  evidence-free ghost judgments.
- **D6 — builder failures are evaluation failures, never silent skips**:
  Why: preserves review-completeness accounting (`failures`, `complete: false`)
  identically for custom and bundled rules.
