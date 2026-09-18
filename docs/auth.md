# jevlint auth spec — API key onboarding via first-run prompt + `setup`

Status: spec only. No `src/` changes, no live Jev calls, no real tokens anywhere.
Canon applied: first-run prompt (primary) + `jevlint setup` (explicit) replace any
login/logout/status suite; two env names (`JEVLINT_TYPESAFE_API_KEY`, plus the shared-global `TYPESAFE_API_KEY` fallback); pre-v1,
zero backwards compat (the old name is not detected, not mentioned, not routed).

## 1. Goal

A stranger on a fresh machine (`npm i -g jevlint`) can reach a first live run with one
interaction and no tribal knowledge. Varlock + 1Password becomes one backend among
several, never the requirement. ADR-0001 is unchanged: auth never passes, fails, bands,
or gates on scores; `setup` reports storage only, never score judgments.

Non-goals: OAuth/device-flow, multiple profiles, key rotation, team provisioning,
storing anything but the single Jev API key.

## 2. UX design

### 2.1 First-run prompt (primary path)

When a live path (`review`, `audit` without `--dry-run`) resolves no credential:

1. If stdin is not a TTY **or** `--no-prompt` was passed → print the missing-credential
   error (§5) and exit 2. Never hang in CI/pipes.
2. Otherwise prompt on stderr (stdout stays report-clean):
   `Enter your Typesafe (Jev) API key: ` with hidden input (no echo). Ctrl-C aborts
   with exit 2 and no error text beyond `jevlint: setup cancelled`.
3. Local sanity check only: non-empty after trim. (No format/prefix assertion — the key
   shape is the SDK's business, and asserting a prefix we don't own creates a false
   compat contract.)
4. Store via §4 (keychain, file fallback), then **continue the run immediately** using
   the just-entered key in memory. No second invocation.
5. Verification *is* the run's first live batch — no separate billed verify call (one
   fewer billed call per onboarding, identical fail-fast: first evaluation failure maps
   to the auth-fix error, §5).

Why no separate verify call: a dead key fails on the first evaluation batch anyway, so
a dedicated ping spends one billed request to learn nothing sooner.

### 2.2 `jevlint setup` (explicit path)

`jevlint setup` runs exactly the prompt+store flow of §2.1 on demand and exits 0.
Uses: re-keying (overwrite stored value, no extra flag needed), headless pre-seeding
(`printf %s "$KEY" | jevlint setup --stdin` — hmm, see `--stdin` below), scripting.

- `jevlint setup --forget`: removes the stored credential from keychain AND file,
  prints `jevlint: stored credential removed`, exits 0. (One flag, ~10 lines — the
  only affordance beyond setup; re-key needs overwrite which setup already does,
  un-key needs this.)
- No `status` command: configured-state is self-evident (the next live run either
  proceeds or prompts), and reporting a backend without a live check would mislead.
- `setup` accepts `--no-prompt` (no-op guard for scripts: with no TTY and no `--stdin`,
  it prints the §5 error) and `--stdin` (read key from stdin pipe, for pre-seeding).
- `setup` never touches scores, cache, or config; it shares the prompt/store code with
  the first-run path (one implementation, two entry points).

### 2.3 Non-interactive escape hatch (mandatory)

- `--token <value>`: explicit per-run token. Top precedence (§3), **never stored**,
  implies non-interactive for that run (no prompt even on TTY — the user spoke).
- `--no-prompt`: fail fast with the §5 error instead of prompting. Auto-engaged when
  stdin is not a TTY (pipes, CI), so a bare `jevlint review < creds` can never hang.
- CI recipe (documented in README): `JEVLINT_TYPESAFE_API_KEY: ${{ secrets.… }}` plus
  `--no-prompt` as a belt-and-braces hang guard.

Why both flags instead of one: `--token` supplies a secret (unsafe in `ps`/history but
explicit and greppable); `--no-prompt` only changes failure mode. Merging them would
force secret-via-argv on anyone who just wants fail-fast.

## 3. Credential precedence (highest first)

| # | Source | Label (`source` in code) | Stored? |
|---|--------|--------------------------|---------|
| 1 | `--token <value>` | `flag` | Never. In-memory for this process only. |
| 2 | `JEVLINT_TYPESAFE_API_KEY` env | `env-jevlint` | Never touched by jevlint (owner: process env). |
| 3 | `TYPESAFE_API_KEY` env (shared global) | `env-shared` | Never touched by jevlint (owner: process env). |
| 4 | OS keychain (`jevlint` / `typesafe-api-key`) | `keychain` | Yes — primary store. |
| 5 | `~/.config/jevlint/credentials` (0600, §4) | `config-file` | Yes — fallback store. |
| 6 | varlock/1Password passthrough (§7) | `varlock` | Never touched by jevlint. |

Two env names, one plain rule: set `JEVLINT_TYPESAFE_API_KEY` or the shared global `TYPESAFE_API_KEY`, and the per-tool variable wins when both are set. The per-tool name stays first so jevlint never silently couples to another tool's ambient credentials; the shared global exists so one key works across Typesafe tools (rangerjev uses it as its only credential). No other names are detected — pre-v1, two names.

First hit wins; lower backends are not consulted (no merging, no union).

## 4. Storage

### 4.1 OS keychain (first choice)

- Library: `keytar`, as an **optionalDependency**, loaded exclusively via dynamic
  `import()` inside a try/catch. Justification: MIT license (publish-friendly); NAPI
  prebuilds via `prebuild-install` (no custom build script on the consumer); correct
  minimal API (`getPassword/setPassword/deletePassword`, service+account).
- Counter-evidence honored, not hidden: latest release is 7.9.0 (2022, atom-org
  lineage), so prebuilds may not cover Node ≥22 and install falls back to `node-gyp`.
  That is exactly why it must be optional + dynamically imported: a missing toolchain
  on a fresh machine degrades to §4.2 instead of breaking `npm i -g`.
- Service `jevlint`, account `typesafe-api-key`. Any load/call failure (module absent,
  native binding missing, headless Linux with no secret service, permission denied) →
  silent skip to file backend. Keychain errors are never surfaced to the user (the file
  fallback succeeding makes them irrelevant; the file fallback failing produces the
  §5 error, not a keychain diagnostic).

### 4.2 File fallback

- Path: `$XDG_CONFIG_HOME/jevlint/credentials`, default `~/.config/jevlint/credentials`
  (`os.homedir()`; `XDG_CONFIG_HOME` honored when set). One line why: XDG user-scoped
  config dir is the cross-platform (mac/linux) convention needing no new dependency,
  and keeping the secret out of the repo working tree is non-negotiable.
- Format: JSON `{"version":1,"typesafeApiKey":"…"}` — the version field buys a
  migration path for future stored fields without a format break.
- Written with mode `0600` (and `0700` on created parent dirs); on read, if existing
  file permissions are more permissive, proceed but warn once on stderr
  (`jevlint: warning: credentials file is group/world-readable; run jevlint setup to re-store`)
  — warn, don't refuse, so a chmod accident can't brick a run.
- Parse failure → treat as absent (fall through to next backend), never crash, never
  print file contents.

### 4.3 In-memory only

`--token` values live in process memory for the run and are never persisted. The
prompt flow persists by default; `setup --stdin` persists (it IS the store flow).
There is no separate `--no-store` flag — the request for ephemerality is spelled
`--token`, one mechanism, no Flag matrix.

## 5. Errors and secrecy rules

- Missing credential (no backend hit + prompting disabled): stderr
  `jevlint: no Typesafe API key found. Set JEVLINT_TYPESAFE_API_KEY or run 'jevlint setup'.`
  Exit 2 (existing CLI usage-error code). Generic by canon: it names the one env var
  and the one command, nothing else.
- Live 401/403-shaped failure from the SDK: stderr
  `jevlint: Typesafe rejected the API key (<source>). Run 'jevlint setup' to store a new key, or set JEVLINT_TYPESAFE_API_KEY.`
  where `<source>` is the §3 label only. Exit 2.
- NEVER print secret values: not in logs, errors, `--debug` output, `--print-config`,
  dumps, or timing tables. Enforcement points (spec → implementation): the resolved
  token lives only inside the `ResolvedCredential` object (§6) and the SDK client;
  `source` labels are the only credential-adjacent strings that may reach stderr/stdout;
  `--print-config` prints the effective *review* config, which must never gain an auth
  field (auth is not configuration). Tests assert absence: feed a canary token through
  every CLI surface and grep outputs for it.
- Auth failures explain the fix (`jevlint setup` / env var) with zero leakage: no key
  prefix, no key length, no "key ending in …", no backend-internal diagnostics.

## 6. The one resolution function

All live paths resolve credentials through exactly one function; nothing else reads
auth inputs (`process.env` auth reads exist in one place only):

```ts
// src/auth.ts
type CredentialSource = "flag" | "env-jevlint" | "env-shared" | "keychain" | "config-file" | "varlock";
interface ResolvedCredential { token: string; source: CredentialSource; }
async function resolveCredential(opts: { tokenFlag?: string }): Promise<ResolvedCredential | undefined>
```

- Order: §3 table top to bottom; first hit returns. `undefined` = run the §2.1
  prompt-or-error flow (caller decides prompt vs error; this function never prompts).
- Backends behind a minimal interface so future stores plug in without touching callers:
  `interface CredentialBackend { name: CredentialSource; read(): Promise<string|undefined>; write?(token): Promise<void>; remove?(): Promise<void>; }`
  (only keychain + file implement `write`/`remove`; flag/env/varlock are read-only).
- Resolved once per process and memoized (the run fans out to hundreds of evaluations;
  keychain round-trips per question would be absurd).
- `TypeSafeEvaluator` receives the token via constructor (`new TypeSafeEvaluator({ apiKey })`)
  and passes it explicitly as `apiKey` to `TypeSafeClient`. It never constructs a
  keyless client, so SDK-native ambient pickup can never silently authenticate outside
  the precedence table. `TYPESAFE_BASE_URL` endpoint override behavior is unchanged.

## 7. varlock/1Password: one backend, never the requirement

- `.env.schema` binding is renamed `TYPESAFE_API_KEY=op(…)` →
  `JEVLINT_TYPESAFE_API_KEY=op(…)` with the **same** `op://` item reference (vault and
  item unchanged; only the binding name moves to the canonical name).
- Consequence: `pnpm jevlint` (`varlock run -- node dist/cli.js`) keeps working
  unchanged — varlock injects the canonical env var, which precedence #2 picks up.
  No code path is varlock-specific in that flow.
- The `varlock` backend (#5, last resort, for bare `jevlint` outside `varlock run`):
  shells out to the project's own varlock CLI in a read-only, non-mutating load and
  reads the canonical name from its output; varlock absent / 1P unreachable / name
  unset → silent skip (returns `undefined`), never an error, never a prompt trigger
  by itself. Exact argv is left to implementation (it must be read-only; verify against
  the installed varlock before merging).
- varlock (and `@varlock/1password-plugin`) stay as-is in `package.json`: still used by
  `pnpm jevlint` / `test:live`, still never required for `npm i -g` strangers.

## 8. Publish-readiness

- No new hard dependency. `keytar` is `optionalDependencies` + dynamic import; pnpm/npm
  never fail an install on an optional native build, and the try/catch covers runtime
  absence. Fresh-machine worst case (no toolchain, headless Linux): keychain silently
  skipped, file backend carries the install. This degradation MUST be covered by a test
  (keytar unresolvable → setup + live resolution still work via file).
- Hidden prompt uses `node:readline` (stdlib) with echo suppression — no new
  dependency for TTY input.
- `engines: node >= 22` unchanged; file backend uses `os.homedir()` + `node:fs`
  only. No platform-specific code ships in the hot path (all keychain access is behind
  the backend interface; Windows works the day keytar loads there, with zero jevlint
  changes).
- `files: [dist, README]` unchanged; no credential fixtures ship (tests use canary
  strings under `os.tmpdir()` HOME overrides; `.gitignore` already covers any stray
  `credentials` file — verify at implementation time).

## 9. Test plan (spec-level, zero live calls)

- Precedence matrix: each backend isolated (fake HOME/XDG, stubbed keytar via
  import-cache seam, synthetic env) asserting winner + `source` label.
- `--token` never persists: run with flag, assert keychain/file untouched.
- Non-TTY + no credential → §5 error text snapshot, exit 2, no prompt attempt.
- Canary test: fixed canary token through prompt/setup/review/audit/`--debug=*`/
  `--print-config`/error paths; assert canary appears nowhere in stdout+stderr.
- `--print-config` output schema unchanged (no auth field).
- `setup --forget` removes from both stores; second `setup` overwrites.
- keytar-absent degradation test (§8).
- Fixtures: none shipped beyond tmpdir canaries (no fixture files needed to prove a
  claim here; registry metadata for keytar 7.9.0/MIT/NAPI-prebuilds was verified live
  during spec and is cited, not vendored).

## 10. Open questions for the coordinator (with recommendations)

1. Verify-call vs fail-fast (§2.1): spec says no billed verify, first batch is the
   check. Recommend: keep — a ping endpoint may not even exist on System One.
2. `setup --stdin` flag name: recommend keep (`--stdin` matches the pre-seed pipe
   idiom; alternatives `--pipe`/`--from-stdin` are wordier for identical meaning).
3. Should `--token` also be honored by `setup` (store the flag value)? Recommend no —
   `printf … | jevlint setup --stdin` covers scripting without argv exposure.
4. Exact read-only varlock argv for backend #5: recommend implementer verifies against
   installed varlock 1.19.0 and reports back; spec constrains it to read-only.
5. Warning vs refusing on group-readable credentials file: recommend warn (spec'd) —
   refusing bricks runs over a chmod accident with no security gain (attacker who can
   read the file already has the key either way).
