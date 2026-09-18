# jevlint

Probabilistic code review for JavaScript and TypeScript. Oxc finds review candidates and builds rule-specific evidence, Jev scores one uncertain proposition per candidate as a probability from 0 to 1, and jevlint reports every judgment with its evidence. Nothing passes or fails.

## Install

Requires Node.js 22 or newer and a `TYPESAFE_API_KEY`. Install globally straight from GitHub (npm 11 or newer needs `--allow-git` for git sources):

```sh
npm install -g --allow-git github:drevantonder/jevlint
```

Set the key once per shell, or save it permanently with setup (writes to `~/.bashrc` and `~/.zshrc`, restart the shell after):

```sh
export TYPESAFE_API_KEY="..."
jevlint setup
```

## First run

```sh
cd your-project
jevlint --rules   # list the 303 bundled rules, exits without evaluating
jevlint review    # score changed code: working tree plus untracked files
jevlint           # bare run audits the whole tree, no diff needed
```

## Review vs audit

`review` scores changed code only, the working-tree diff against `HEAD` plus untracked source files, so a clean tree has nothing to score. `audit` surveys the whole codebase with no diff needed and runs to completion unless you opt into a limit. Both report probabilities only.

## Flags

```text
--rules                  list bundled rule keys and exit (JSON array with --format json)
--debug=files            print the resolved scope and exit without evaluating
--debug=timings          print a per-rule timing table after the report
--debug=cache            print cache statistics
--print-config           print the effective config as JSON and exit
--format <text|json|github>  (-f) github emits one workflow annotation per judgment
--out-dir <dir>          write one JSON artifact per evaluated file plus summary.json
--staged                 review staged changes only (review)
--max-questions <n>      audit limit; the rest are reported as omitted, never sampled
--evidence-budget-ms <n> audit preparation wall-clock budget
--dry-run                prepare and count questions with zero live requests
--refresh-cache          force fresh judgments (judgments are cached by default)
--no-cache               bypass the judgment cache for this run
--min-score <p>          filter text rendering to judgments at or above p
--limit <n>              text rendering shows the top n (default 5, 0 shows none)
```

`--min-score` and `--limit` shape text rendering only. The JSON report always holds every completed judgment.

## Output

Each judgment carries a probability, the rule proposition, the candidate file span, and the bounded evidence behind the score. Text output ranks judgments by descending probability and ends with a summary line of evaluated, displayed, abstained, and failed counts. Candidates a rule cannot apply to are counted as structural abstentions, never as zero scores.

A completed run exits 0 no matter how high the probabilities are. Bad arguments, config or git failures, API failures, and incomplete runs exit 2.

## Configuration

`jevlint` reads `jevlint.config.ts` (and common JS module variants) in the current directory. Set a bundled rule to `"off"` to disable it. A `rules` key that matches no bundled or plugin rule is an error, so misspellings fail loudly instead of scoring nothing.

```ts
import { defineConfig } from "jevlint";

export default defineConfig({
  rules: {
    "jev/no-narrating-comment": "off",
  },
});
```

## Custom rules

Projects add namespaced rules through a local plugin file registered in the config. The full contract, with the evidence-builder shape and scoping rules, lives in [`docs/custom-rules-spec.md`](docs/custom-rules-spec.md).

```ts
// jevlint.config.ts
import { defineConfig } from "jevlint";

export default defineConfig({
  plugins: [{ name: "acme", specifier: "./jevlint-rules/todo-tickets.ts" }],
});
```

## Agent skill

An agent skill ships in [`skills/jevlint/SKILL.md`](skills/jevlint/SKILL.md). Copy that folder into your agent's skills directory to drive jevlint from an agent.

## Development

```sh
git clone https://github.com/drevantonder/jevlint.git && cd jevlint
pnpm install && pnpm build
pnpm test    # deterministic fakes, never calls the Jev API
```

`pnpm test:live` checks rule fixtures against the real Jev API and needs `TYPESAFE_API_KEY`.
