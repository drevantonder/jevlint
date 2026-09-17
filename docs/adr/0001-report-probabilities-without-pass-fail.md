# Report probabilities without pass or fail

Jevlint reports every completed rule judgment as a probability and does not decide whether changed code passes or fails. Thresholds, severities, binary diagnostic filtering, and root-cause suppression would discard uncertainty or encode policy that belongs to the report consumer, so they are not part of the rule or output contract.

## Consequences

A completed review exits successfully regardless of its scores. Structural ineligibility and evaluation failure remain distinct from low probabilities, and display filters may shorten presentation without changing the underlying review.
