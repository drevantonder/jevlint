# rulehealth — jevlint reviews its own rules

This plugin turns jevlint's custom-rules support on jevlint itself. Three
meta-rules read the rule corpus (the evidence builders in `src/evidence/*`
and the propositions in `src/defaults.ts`) and describe the shape they find.
Each judgment carries the structural evidence behind it; what the corpus
means stays a human call.

## Running the meta-rules

Build first, then scope the run to the corpus with PATHs:

```sh
pnpm build
node dist/cli.js audit src/evidence src/defaults.ts
```

The builders abstain on every file outside the corpus by construction, so a
full-tree run stays quiet apart from corpus files. Passing PATHs just limits
the work. `--dry-run` prepares the questions without calling an evaluator,
which is a useful way to see which corpus files produce evidence.

## The meta-rules

- `rulehealth/no-unbounded-evidence` — describes builders that iterate the
  whole project for each candidate without a named cap (`MAX_` constant,
  sliced file list, or small count bound) on what they gather.
- `rulehealth/no-missing-abstention` — describes builders with no path back
  to no evidence (`return undefined` or `?? undefined`). Such a builder
  always produces an evidence object, so every candidate gets a scored
  answer even where there is nothing to judge.
- `rulehealth/no-unfalsifiable-proposition` — describes propositions in
  `src/defaults.ts` that state no answer conditions, or whose question is
  too short to name an observation and its context.

## Adding a meta-rule

1. Write a synchronous `build*Evidence` function in `src/rulehealth/` and
   add its descriptor to the `rules` map in `src/rulehealth/plugin.ts`.
   Keep the scope `module`: one candidate per file.
2. Judge only corpus files and return `undefined` everywhere else. Look the
   file source up in `projectFiles` by `candidate.filePath`; module
   candidates carry no source of their own.
3. Name the evidence: file path, the lines or fields behind the judgment,
   and what would change the answer.
4. Add fixtures to `test/rulehealth-evidence.test.ts`: a healthy builder
   that abstains, and each violation shape with its named evidence.
5. Run `pnpm check` and read the corpus findings the new rule surfaces.
