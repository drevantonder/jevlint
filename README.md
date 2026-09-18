# jevlint

> Very early days, mostly a proof of concept. Feedback is welcome via issues. Suggest new rules, or adjustments to current ones, with a pull request.

Oxc finds review candidates and builds rule-specific evidence. Jev scores one proposition per judgment as a probability from 0 to 1. The report states probabilities only and never passes or fails.

Three hundred nineteen bundled Jev rules. The bundled Jev rules are catalogued in `src/defaults.ts` (rule set, order, scope, category, and question text).

## Install

Needs Node.js 22 or newer. The only credential is `TYPESAFE_API_KEY`, read from the environment on each live run and stored nowhere. A missing key exits 2 naming the variable.

```sh
pnpm install
pnpm build
export TYPESAFE_API_KEY="your-key"
pnpm jevlint
```

Bare `jevlint` audits the whole tree. Use `review` when you only changed some files. `pnpm jevlint --rules` lists every enabled rule and exits without calling Jev.

## Review vs audit

`review` scores changed files. `audit` surveys the whole tree.

```sh
pnpm jevlint review
pnpm jevlint audit
```

Paths filter any run: `pnpm jevlint audit src/checkout`.
`--format json` prints the machine-readable report.
`--format github` emits one workflow annotation per judgment.
`--out-dir ./jevlint-out` writes per-file JSON plus `summary.json`.

A completed review exits 0 whatever the probabilities. Bad arguments, config, git, or API failures exit 2. Judgments are cached in the worktree's git metadata; see docs/caching.md.

## Config

`jevlint.config.ts` in the current directory. `"off"` disables a rule. One rule is opt-in:

```ts
import { defineConfig, optInRuleDefaults } from "jevlint";

export default defineConfig({
  rules: {
    "jev/no-narrating-comment": "off",
    "jev/no-unlocalized-user-string": optInRuleDefaults["jev/no-unlocalized-user-string"],
  },
});
```

Custom rules are local plugin files registered in the config; the contract is docs/custom-rules-spec.md. An agent skill ships at skills/jevlint/SKILL.md.

## Development

```sh
pnpm test
pnpm test:live
pnpm lint
pnpm check
pnpm build
```

The normal suite uses deterministic fakes and never calls Jev. `pnpm test:live` reads `TYPESAFE_API_KEY` and checks rule fixtures against the real API.
