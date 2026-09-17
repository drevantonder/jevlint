# jevlint

A diff-aware semantic linter for JavaScript and TypeScript. Oxc discovers candidates and builds rule-specific repository evidence. [Jev](https://docs.typesafe.ai/introduction) makes narrow semantic judgments and returns probabilities that jevlint turns into diagnostics.

## Status

This first slice supports:

- JavaScript, JSX, TypeScript, and TSX
- Working-tree and staged Git changes
- Function, comment, abstraction, and whole-change rules
- Repository-aware evidence from imports, callers, implementations, and option usage
- Before/after evidence for change-level judgments
- Root-cause deduplication for overlapping accidental-complexity findings
- TypeScript configuration
- Text and JSON diagnostics
- Fifteen bundled Jev rules
- A local Oxlint anti-slop plugin for deterministic TypeScript checks

The bundled Jev rules flag:

- mutation of caller-owned inputs that the function contract does not disclose
- comments that repeat nearby code
- wrappers that add no meaningful behavior
- names that obscure a function's purpose
- speculative generality
- ad-hoc special-case branching
- correlated booleans that admit contradictory states
- unconstrained strings used as closed internal states
- flat records that permit invalid discriminant and payload combinations
- needless abstractions
- generic reflective machinery for fixed operations
- configuration disproportionate to observed use
- avoidable sequential orchestration
- changes that displace rather than reduce complexity
- feature envy

The hidden-input-mutation rule uses Oxc to prove that an argument is changed, then asks Jev whether the API makes the in-place behavior clear. Pure copies never reach Jev, while explicit mutable protocols remain valid.

The eight accidental-complexity rules use Oxc for factual candidate discovery and evidence collection, then ask Jev to distinguish a smell from legitimate boundaries, variation, policy, and dependency constraints. The state-modeling rules distinguish correlated lifecycle flags from independent booleans, closed internal states from open strings, and conditionally required payloads from optional metadata or boundary contracts. The principles were adapted from Cursor's [Thermo-Nuclear Code Quality Review](https://github.com/cursor/plugins/blob/main/cursor-team-kit/skills/thermo-nuclear-code-quality-review/SKILL.md) and Matt Pocock's [Code Review](https://github.com/mattpocock/skills/blob/main/skills/engineering/code-review/SKILL.md).

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

Analyze staged and unstaged changes relative to `HEAD`, plus untracked source files:

```sh
pnpm jevlint diff
```

Analyze only staged changes:

```sh
pnpm jevlint diff --staged
```

Produce machine-readable output:

```sh
pnpm jevlint diff --format json
```

When using a globally linked binary, wrap it directly:

```sh
varlock run -- jevlint diff
```

Warnings do not fail the command. Diagnostics configured as errors produce exit code 1. Invalid arguments, configuration failures, Git failures, and API failures produce exit code 2.

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
      threshold: 0.9,
      severity: "error",
      message: "Function name does not match its behavior.",
    },
  },
});
```

Each rule uses a Jev Noul question. A result at or above `threshold` creates a diagnostic at the Oxc candidate's source span. Bundled accidental-complexity rules first apply structural gates, so Jev is called only when Oxc finds the relevant mechanism. Repository evidence is bounded and rule-specific rather than a generic whole-project prompt.

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
