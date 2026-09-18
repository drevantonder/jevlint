# jevlint auth

One credential: the `TYPESAFE_API_KEY` environment variable. Nothing else.

## First run

Set the variable, or run `jevlint setup`: it asks for the key once (hidden
input) and appends `export TYPESAFE_API_KEY='…'` to `~/.bashrc` and
`~/.zshrc`. Files that do not exist are created with mode `0600`; files that
exist are backed up to `<file>.jevlint.bak` before editing. Re-runs replace
the old line instead of duplicating it. Then restart the shell (or run the
printed `source` line). `jevlint setup --forget` removes those lines.

## Live runs

Every live run (`review`, `audit` without `--dry-run`) reads
`TYPESAFE_API_KEY` and nothing else. When it is missing or empty, jevlint
prints one error and exits 2:

```text
jevlint: no Typesafe API key found. Set TYPESAFE_API_KEY or run 'jevlint setup'.
```

A key the API rejects maps to
`Typesafe rejected the API key (env). …`, exit 2. The key value never appears
in output, logs, `--debug`, or `--print-config` (canary tests enforce this).

## CI

Set `TYPESAFE_API_KEY` from the secret store. No flags, no files.
