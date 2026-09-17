import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { defaultConfig, loadConfig } from "../src/config.js";

describe("loadConfig", () => {
  it("uses the bundled rules when no config file exists", async () => {
    const directory = await mkdtemp(join(tmpdir(), "jevlint-config-"));

    const config = await loadConfig({ cwd: directory });

    expect(Object.keys(config.rules)).toEqual([
      "jev/no-hidden-input-mutation",
      "jev/no-hidden-io",
      "jev/no-lossy-sentinel-return",
      "jev/no-query-side-effect",
      "jev/no-narrating-comment",
      "jev/no-pass-through-wrapper",
      "jev/no-mysterious-name",
      "jev/no-speculative-generality",
      "jev/no-ad-hoc-branching",
      "jev/no-mixed-responsibilities",
      "jev/no-data-clump",
      "jev/no-scattered-policy",
      "jev/no-correlated-state-booleans",
      "jev/no-unconstrained-state-string",
      "jev/no-conditionally-valid-state",
      "jev/no-needless-abstraction",
      "jev/no-generic-magic",
      "jev/no-disproportionate-configuration",
      "jev/no-avoidable-orchestration",
      "jev/no-hidden-runtime-input",
      "jev/no-hidden-initialization-order",
      "jev/no-implicit-atomicity",
      "jev/no-complexity-displacement",
      "jev/no-transport-coupled-domain",
      "jev/no-persistence-model-leak",
      "jev/no-interchangeable-domain-primitives",
      "jev/no-domain-policy-in-adapter",
      "jev/no-swallowed-error",
      "jev/no-lossy-error-translation",
      "jev/no-unsafe-retry",
      "jev/no-hidden-partial-failure",
      "jev/no-duplicated-logic",
      "jev/no-type-code-dispatch",
      "jev/no-mode-flag-parameter",
      "jev/no-message-chain",
      "jev/no-mixed-abstraction-levels",
      "jev/no-unvalidated-boundary-shape",
      "jev/no-stale-binding-use",
      "jev/no-pre-gate-side-effect",
      "jev/no-inverted-authorization-predicate",
      "jev/no-hardcoded-config-shadow",
      "jev/no-sibling-identifier-swap",
      "jev/no-feature-envy",
      "jev/no-foreign-mutation",
      "jev/no-temporal-call-coupling",
      "jev/no-shotgun-change",
      "jev/no-undocumented-contract",
      "jev/no-unbounded-wait",
      "jev/no-detached-async-work",
      "jev/no-shared-mutable-module-state",
      "jev/no-type-checker-escape",
      "jev/no-unawaited-iteration-work",
      "jev/no-asymmetric-normalization",
      "jev/no-unguarded-nullable-dereference",
      "jev/no-falsy-absent-conflation",
      "jev/no-unanchored-domain-check",
      "jev/no-contract-signature-drift",
      "jev/no-accidental-serialization",
      "jev/no-discarded-transformation",
      "jev/no-load-bearing-async",
      "jev/no-untrusted-sink-input",
      "jev/no-unreleased-subscription",
      "jev/no-unwieldy-signature",
      "jev/no-inappropriate-intimacy",
      "jev/no-anemic-type",
      "jev/no-temporary-field",
      "jev/no-low-cohesion-class",
      "jev/no-divergent-change",
      "jev/no-divergent-sibling-interfaces",
      "jev/no-refused-inheritance",
      "jev/no-unnamed-parameter-object",
      "jev/no-predictable-token",
      "jev/no-unreachable-guard",
      "jev/no-unaccountable-todo",
      "jev/no-adversarial-regex",
      "jev/no-live-credential",
      "jev/no-output-argument",
      "jev/no-contextless-error",
      "jev/no-unchecked-precondition",
      "jev/no-unenforced-warning-comment",
      "jev/no-table-shaped-conditional",
      "jev/no-sequential-step-soup",
      "jev/no-mirrored-derived-state",
      "jev/no-construction-in-use",
      "jev/no-retry-storm-shape",
      "jev/no-unbounded-accumulation",
      "jev/no-call-in-loop-persistence",
      "jev/no-unbounded-parallel-fanout",
      "jev/no-concurrent-shared-mutation",
      "jev/no-sensitive-data-in-log",
      "jev/no-unsafe-redirect-target",
      "jev/no-overbroad-origin-trust",
      "jev/no-path-traversal-join",
      "jev/no-phantom-member-access",
      "jev/no-laundered-absence",
      "jev/no-unverified-claim",
      "jev/no-convention-breaking-addition",
      "jev/no-repeated-handler-preamble",
      "jev/no-non-narrowing-guard",
      "jev/no-excess-context-parameter",
      "jev/no-shallow-convenience-layer",
      "jev/no-prototype-in-production",
      "jev/no-hidden-loop-exit",
      "jev/no-inconsistent-error-contract",
      "jev/no-breaking-export-reshape",
      "jev/no-positional-extension-drift",
      "jev/no-mixed-absence-convention",
      "jev/no-shared-mutable-default",
      "jev/no-blocking-event-loop-call",
      "jev/no-unguarded-async-init",
      "jev/no-promise-combinator-mismatch",
      "jev/no-orphaned-timer",
      "jev/no-unsynchronized-shared-memory",
      "jev/no-timezone-naive-arithmetic",
      "jev/no-floating-money-arithmetic",
      "jev/no-offset-pagination-drift",
      "jev/no-unit-scale-mismatch",
      "jev/no-truncating-numeric-parse",
      "jev/no-locale-date-serialization",
      "jev/no-overload-resolution-ambiguity",
      "jev/no-sync-async-sibling-ambiguity",
      "jev/no-leaky-internal-export",
      "jev/no-weak-crypto-primitive",
      "jev/no-disabled-tls-verification",
      "jev/no-dynamic-code-execution",
      "jev/no-locale-blind-ordering",
      "jev/no-cascading-fallback",
      "jev/no-silent-queue-drop",
      "jev/no-missing-shutdown-drain",
      "jev/no-missing-health-signal",
      "jev/no-deployment-coupled-assumption",
      "jev/no-assertion-free-test",
      "jev/no-sleep-in-test",
      "jev/no-logic-in-test",
      "jev/no-mock-everything",
      "jev/no-duplicated-fixture-drift",
      "jev/no-stale-feature-flag",
      "jev/no-unlabeled-interactive-element",
      "jev/no-unlocalized-user-string",
      "jev/no-console-residue",
      "jev/no-deep-happy-path-nesting",
      "jev/no-drilled-prop",
      "jev/no-stale-comment",
      "jev/no-paraphrased-sibling-logic",
      "jev/no-unclosed-handle",
      "jev/no-bespoke-crypto-construction",
      "jev/no-duplicated-style-object",
      "jev/no-unmeasured-performance-machinery",
      "jev/no-unmigrated-schema-change",
      "jev/no-unconsumed-telemetry",
      "jev/no-english-only-pluralization",
      "jev/no-duplicate-config-source",
      "jev/no-unowned-feature-flag",
      "jev/no-superseded-api-use",
      "jev/no-phantom-package-import",
      "jev/no-interaction-pinning-test",
      "jev/no-single-use-dependency",
      "jev/no-second-shelf-dependency",
      "jev/no-repeated-test-preamble",
      "jev/no-unpinned-boundary-branch",
      "jev/no-client-only-authorization",
      "jev/no-check-then-act-race",
      "jev/no-non-idempotent-retry",
      "jev/no-parallel-abstraction",
      "jev/no-misplaced-error-boundary",
      "jev/no-rare-case-first",
      "jev/no-side-effecting-conditional-expression",
      "jev/no-unexplained-complex-condition",
      "jev/no-clever-expression",
      "jev/no-hand-rolled-group-by",
      "jev/no-hand-rolled-deep-clone",
      "jev/no-hand-rolled-set-ops",
      "jev/no-hand-rolled-flatten",
      "jev/no-hand-rolled-deep-equal",
      "jev/no-hand-rolled-schema-check",
      "jev/no-hand-rolled-retry-loop",
      "jev/no-hand-rolled-concurrency-limit",
      "jev/no-hand-rolled-debounce",
      "jev/no-hand-rolled-csv-split",
      "jev/no-nested-conditional-expression",
      "jev/no-unexplained-behavioral-literal",
      "jev/no-shadowed-meaning",
      "jev/no-oversized-working-set",
    ]);
  });

  it("rejects retired threshold and severity settings", async () => {
    const directory = await mkdtemp(join(tmpdir(), "jevlint-config-"));
    await writeFile(
      join(directory, "jevlint.config.ts"),
      `export default {
        rules: {
          "personal/invalid": {
            scope: "function",
            question: { instructions: "Is this invalid?" },
            threshold: 2,
            severity: "warning",
            message: "Invalid threshold."
          }
        }
      }`,
    );

    await expect(loadConfig({ cwd: directory })).rejects.toThrow();
  });

  it("loads TypeScript config and allows bundled rules to be disabled", async () => {
    const directory = await mkdtemp(join(tmpdir(), "jevlint-config-"));
    const configPath = join(directory, "jevlint.config.ts");
    await writeFile(
      configPath,
      `export default {
        rules: {
          "jev/no-narrating-comment": "off",
          "personal/suspicious-name": {
            scope: "function",
            question: { instructions: "Is this function misleadingly named?" },
            message: "Function name does not match its behavior."
          }
        }
      }`,
    );

    const config = await loadConfig({ cwd: directory });

    expect(config.rules["jev/no-narrating-comment"]).toBeUndefined();
    expect(config.rules["jev/no-pass-through-wrapper"]).toEqual(
      defaultConfig.rules["jev/no-pass-through-wrapper"],
    );
    expect(config.rules["personal/suspicious-name"]).toEqual({
      scope: "function",
      question: { instructions: "Is this function misleadingly named?" },
      message: "Function name does not match its behavior.",
    });
  });
});
