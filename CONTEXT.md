# Jevlint review

Jevlint reviews changed code by pairing structural source analysis with probabilistic rule evaluation. Its output preserves evidence and uncertainty for a human or downstream tool to interpret.

## Language

**Candidate**:
A changed source span that is structurally eligible for one or more review rules.
_Avoid_: Finding, violation

**Judgment**:
A rule proposition evaluated for one candidate, expressed as a probability with its source span and structural evidence.
_Avoid_: Diagnostic, lint error

**Review report**:
The result of one review, containing its judgments and summaries of structural abstentions and evaluation failures.
_Avoid_: Lint result

**Structural abstention**:
A rule and candidate pairing that deterministic analysis excludes before probabilistic evaluation because the required code structure or evidence is absent. It has no probability.
_Avoid_: Zero score, clean result

**Evaluation failure**:
A rule and candidate pairing for which probabilistic evaluation did not return a valid answer. It has no probability and makes the review incomplete.
_Avoid_: Failed judgment, zero score
