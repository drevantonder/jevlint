# jevlint auth

One credential: the `TYPESAFE_API_KEY` environment variable. Set it, done.
Nothing is stored anywhere, ever: no setup command, no prompt, no keychain,
no config file, no shell-file edits.

## Live runs

Every live run (`review`, `audit` without `--dry-run`) reads
`TYPESAFE_API_KEY` and nothing else. When it is missing or empty, jevlint
prints one error and exits 2:

```text
jevlint: no Typesafe API key found. Set TYPESAFE_API_KEY.
```

A key the API rejects maps to
`Typesafe rejected the API key (env). …`, exit 2. The key value never appears
in output, logs, `--debug`, or `--print-config` (canary tests enforce this).

## CI

Set `TYPESAFE_API_KEY` from the secret store. No flags, no files.
