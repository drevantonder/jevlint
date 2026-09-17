# Jev response cache

Jevlint keeps a local content-addressed cache of Jev judgments. It does not cache parsing, changed-line filtering, candidate discovery, evidence collection, or report formatting. Those deterministic steps run on every invocation.

## Cache boundary

A **candidate** is a structural source span found by Oxc. A **judgment** is one Noul question evaluated by Jev against the evaluation state. Jevlint reports every completed judgment with its probability, message, span, and evidence; it applies no local pass/fail policy to the score.

The cache stores judgments at the `Evaluator` boundary. TypeSafe documents that questions in one System One request see the same state and run independently. Jevlint therefore caches each question separately while still batching misses into one live request. Adding or removing another question does not invalidate an otherwise identical judgment.

The evaluation state currently contains the candidates selected for one changed file and their bounded, rule-specific repository evidence. This is conservative. A change to any candidate or evidence in that shared state invalidates all judgments over that state, even when one rule may not need the changed field. Jevlint never reuses a result across different actual Jev state.

## Keys and invalidation

Each SHA-256 key uses canonical JSON with sorted object keys and ordered arrays. It covers:

- cache format version
- canonical repository worktree path
- provider and endpoint
- pinned model ID, currently `jev-1.13.0`
- TypeSafe SDK version
- Jevlint evaluator version
- the exact state sent to TypeSafe, including repository-relative file path, compact module context, normalized candidate source and nearby source, source kind and lines, and rule-specific evidence
- the exact Noul question, including rule ID, evaluation schema version, prompt instructions, and criteria

Question map IDs are excluded because TypeSafe does not send them to the model. Rule IDs remain part of the question instructions and key. Rule messages are excluded because they are presentation applied after Jev returns a probability. Changing a message reuses the semantic judgment and reapplies the new wording.

Jevlint pins a versioned model instead of the moving `jev-latest` alias. Model, SDK, evaluator, schema, prompt, candidate, and evidence changes all produce misses.

## Location and scope

The cache directory is resolved with:

```sh
git rev-parse --path-format=absolute --git-path jevlint/cache/v1
```

This puts it under the current repository or worktree's Git metadata, normally `.git/jevlint/cache/v1`. It cannot be committed, so `.gitignore` needs no cache entry. The canonical worktree path is also part of every key, which prevents reuse across repositories and separate worktrees.

`v1` is the on-disk format version. A future incompatible format will use another directory and key format.

## Stored data and writes

Each file stores only its format marker, content digest, and probability. Source, evidence, prompts, paths, API keys, and 1Password credentials are not written. Directories use mode `0700` when created and files use `0600`.

Jevlint writes a unique temporary file in the destination directory and atomically renames it into place. Concurrent identical misses in one process share a live evaluation. Separate processes may both evaluate a miss, but their atomic writes cannot leave a partial entry. A malformed, truncated, mismatched, or out-of-range entry is a miss and gets replaced after a successful evaluation.

## Controls and observability

Caching is on by default.

```sh
jevlint review --no-cache
jevlint review --refresh-cache
jevlint review --verbose
```

`--no-cache` bypasses reads and writes. `--refresh-cache` bypasses reads, performs live evaluations, and atomically replaces matching entries. `--verbose` writes one cache summary to stderr after analysis. Normal output stays unchanged.
