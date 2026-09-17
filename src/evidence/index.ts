import type { JsonValue } from "@typesafe-ai/sdk";
import type { Candidate, ProjectFile, SourceFile } from "../types.js";
import { buildAccidentalSerializationEvidence } from "./accidental-serialization.js";
import { buildAdHocBranchingEvidence } from "./ad-hoc-branching.js";
import { buildAnemicTypeEvidence } from "./anemic-type.js";
import { buildAsymmetricNormalizationEvidence } from "./asymmetric-normalization.js";
import { buildAdversarialRegexEvidence } from "./adversarial-regex.js";
import { buildAvoidableOrchestrationEvidence } from "./avoidable-orchestration.js";
import { buildCallInLoopPersistenceEvidence } from "./call-in-loop-persistence.js";
import { buildComplexityDisplacementEvidence } from "./complexity-displacement.js";
import { buildConcurrentSharedMutationEvidence } from "./concurrent-shared-mutation.js";
import { buildConditionallyValidStateEvidence } from "./conditionally-valid-state.js";
import { buildCorrelatedStateBooleansEvidence } from "./correlated-state-booleans.js";
import { buildContractSignatureDriftEvidence } from "./contract-signature-drift.js";
import { buildConventionBreakingAdditionEvidence } from "./convention-breaking-addition.js";
import { buildDataClumpEvidence } from "./data-clump.js";
import { buildDetachedAsyncWorkEvidence } from "./detached-async-work.js";
import { buildDisproportionateConfigurationEvidence } from "./disproportionate-configuration.js";
import { buildCascadingFallbackEvidence } from "./cascading-fallback.js";
import { buildDeploymentCoupledAssumptionEvidence } from "./deployment-coupled-assumption.js";
import { buildDiscardedTransformationEvidence } from "./discarded-transformation.js";
import { buildDivergentChangeEvidence } from "./divergent-change.js";
import { buildDivergentSiblingInterfacesEvidence } from "./divergent-sibling-interfaces.js";
import { buildDomainPolicyInAdapterEvidence } from "./domain-policy-in-adapter.js";
import { buildDuplicatedLogicEvidence } from "./duplicated-logic.js";
import { buildForeignMutationEvidence } from "./foreign-mutation.js";
import { buildGenericMagicEvidence } from "./generic-magic.js";
import { buildFalsyAbsentConflationEvidence } from "./falsy-absent-conflation.js";
import { buildHiddenInputMutationEvidence } from "./hidden-input-mutation.js";
import { buildExcessContextParameterEvidence } from "./excess-context-parameter.js";
import { buildHiddenIoEvidence } from "./hidden-io.js";
import { buildBreakingExportEvidence } from "./breaking-export-reshape.js";
import { buildHiddenLoopExitEvidence } from "./hidden-loop-exit.js";
import { buildInconsistentErrorContractEvidence } from "./inconsistent-error-contract.js";
import { buildMixedAbsenceConventionEvidence } from "./mixed-absence-convention.js";
import { buildPositionalExtensionDriftEvidence } from "./positional-extension-drift.js";
import { buildSharedMutableDefaultEvidence } from "./shared-mutable-default.js";
import { buildBlockingEventLoopCallEvidence } from "./blocking-event-loop-call.js";
import { buildUnguardedAsyncInitEvidence } from "./unguarded-async-init.js";
import { buildPromiseCombinatorMismatchEvidence } from "./promise-combinator-mismatch.js";
import { buildOrphanedTimerEvidence } from "./orphaned-timer.js";
import { buildUnsynchronizedSharedMemoryEvidence } from "./unsynchronized-shared-memory.js";
import { buildOverloadResolutionAmbiguityEvidence } from "./overload-resolution-ambiguity.js";
import { buildSyncAsyncSiblingAmbiguityEvidence } from "./sync-async-sibling-ambiguity.js";
import { buildLeakyInternalExportEvidence } from "./leaky-internal-export.js";
import { buildWeakCryptoPrimitiveEvidence } from "./weak-crypto-primitive.js";
import { buildHiddenPartialFailureEvidence } from "./hidden-partial-failure.js";
import { buildHardcodedConfigShadowEvidence } from "./hardcoded-config-shadow.js";
import { buildHiddenInitializationOrderEvidence } from "./hidden-initialization-order.js";
import { buildHiddenRuntimeInputEvidence } from "./hidden-runtime-input.js";
import { buildInvertedAuthorizationPredicateEvidence } from "./inverted-authorization-predicate.js";
import { buildImplicitAtomicityEvidence } from "./implicit-atomicity.js";
import { buildInappropriateIntimacyEvidence } from "./inappropriate-intimacy.js";
import { buildInterchangeableDomainPrimitivesEvidence } from "./interchangeable-domain-primitives.js";
import { buildLossyErrorTranslationEvidence } from "./lossy-error-translation.js";
import { buildLoadBearingAsyncEvidence } from "./load-bearing-async.js";
import { buildLowCohesionClassEvidence } from "./low-cohesion-class.js";
import { buildLiveCredentialEvidence } from "./live-credential.js";
import { buildLossySentinelReturnEvidence } from "./lossy-sentinel-return.js";
import { buildMessageChainEvidence } from "./message-chain.js";
import { buildMissingHealthSignalEvidence } from "./missing-health-signal.js";
import { buildMissingShutdownDrainEvidence } from "./missing-shutdown-drain.js";
import { buildLaunderedAbsenceEvidence } from "./laundered-absence.js";
import { buildMixedAbstractionLevelsEvidence } from "./mixed-abstraction-levels.js";
import { buildMixedResponsibilitiesEvidence } from "./mixed-responsibilities.js";
import { buildModeFlagParameterEvidence } from "./mode-flag-parameter.js";
import { buildStaleBindingUseEvidence } from "./stale-binding-use.js";
import { buildNeedlessAbstractionEvidence } from "./needless-abstraction.js";
import { buildNonNarrowingGuardEvidence } from "./non-narrowing-guard.js";
import { buildSiblingIdentifierSwapEvidence } from "./sibling-identifier-swap.js";
import { buildOverbroadOriginTrustEvidence } from "./overbroad-origin-trust.js";
import { buildPassThroughWrapperEvidence } from "./pass-through-wrapper.js";
import { buildPathTraversalJoinEvidence } from "./path-traversal-join.js";
import { buildPreGateSideEffectEvidence } from "./pre-gate-side-effect.js";
import { buildPersistenceModelLeakEvidence } from "./persistence-model-leak.js";
import { buildPhantomMemberAccessEvidence } from "./phantom-member-access.js";
import { buildPrototypeInProductionEvidence } from "./prototype-in-production.js";
import { buildQuerySideEffectEvidence } from "./query-side-effect.js";
import { buildRefusedInheritanceEvidence } from "./refused-inheritance.js";
import { buildRepeatedHandlerPreambleEvidence } from "./repeated-handler-preamble.js";
import { buildRetryStormEvidence } from "./retry-storm-shape.js";
import { buildScatteredPolicyEvidence } from "./scattered-policy.js";
import { buildSensitiveDataInLogEvidence } from "./sensitive-data-in-log.js";
import { buildSharedMutableModuleStateEvidence } from "./shared-mutable-module-state.js";
import { buildShallowConvenienceLayerEvidence } from "./shallow-convenience-layer.js";
import { buildSilentQueueDropEvidence } from "./silent-queue-drop.js";
import { buildShotgunChangeEvidence } from "./shotgun-change.js";
import { buildSpeculativeGeneralityEvidence } from "./speculative-generality.js";
import { buildSwallowedErrorEvidence } from "./swallowed-error.js";
import { buildTemporalCallCouplingEvidence } from "./temporal-call-coupling.js";
import { buildTemporaryFieldEvidence } from "./temporary-field.js";
import { buildUnvalidatedBoundaryEvidence } from "./unvalidated-boundary-shape.js";
import { buildTransportCoupledDomainEvidence } from "./transport-coupled-domain.js";
import { buildTypeCheckerEscapeEvidence } from "./type-checker-escape.js";
import { buildTableConditionalEvidence } from "./table-shaped-conditional.js";
import { buildSequentialStepSoupEvidence } from "./sequential-step-soup.js";
import { buildMirroredDerivedStateEvidence } from "./mirrored-derived-state.js";
import { buildConstructionInUseEvidence } from "./construction-in-use.js";
import { buildTypeCodeDispatchEvidence } from "./type-code-dispatch.js";
import { buildUnanchoredDomainCheckEvidence } from "./unanchored-domain-check.js";
import { buildUnawaitedIterationWorkEvidence } from "./unawaited-iteration-work.js";
import { buildUnboundedAccumulationEvidence } from "./unbounded-accumulation.js";
import { buildUnboundedParallelFanoutEvidence } from "./unbounded-parallel-fanout.js";
import { buildUnboundedWaitEvidence } from "./unbounded-wait.js";
import { buildUnconstrainedStateStringEvidence } from "./unconstrained-state-string.js";
import { buildUndocumentedContractEvidence } from "./undocumented-contract.js";
import { buildUnguardedNullableDereferenceEvidence } from "./unguarded-nullable-dereference.js";
import { buildUnreleasedSubscriptionEvidence } from "./unreleased-subscription.js";
import { buildUnnamedParameterObjectEvidence } from "./unnamed-parameter-object.js";
import { buildPredictableTokenEvidence } from "./predictable-token.js";
import { buildUnreachableGuardEvidence } from "./unreachable-guard.js";
import { buildUnsafeRedirectTargetEvidence } from "./unsafe-redirect-target.js";
import { buildUnsafeRetryEvidence } from "./unsafe-retry.js";
import { buildUntrustedSinkInputEvidence } from "./untrusted-sink-input.js";
import { buildUnwieldySignatureEvidence } from "./unwieldy-signature.js";
import { buildOutputArgumentEvidence } from "./output-argument.js";
import { buildContextlessErrorEvidence } from "./contextless-error.js";
import { buildUncheckedPreconditionEvidence } from "./unchecked-precondition.js";
import { buildUnenforcedWarningCommentEvidence } from "./unenforced-warning-comment.js";
import { buildTimezoneNaiveArithmeticEvidence } from "./timezone-naive-arithmetic.js";
import { buildFloatingMoneyArithmeticEvidence } from "./floating-money-arithmetic.js";
import { buildOffsetPaginationDriftEvidence } from "./offset-pagination-drift.js";
import { buildUnitScaleMismatchEvidence } from "./unit-scale-mismatch.js";
import { buildTruncatingNumericParseEvidence } from "./truncating-numeric-parse.js";
import { buildLocaleDateSerializationEvidence } from "./locale-date-serialization.js";
import { buildDisabledTlsVerificationEvidence } from "./disabled-tls-verification.js";
import { buildDynamicCodeExecutionEvidence } from "./dynamic-code-execution.js";
import { buildLocaleBlindOrderingEvidence } from "./locale-blind-ordering.js";
import { buildAssertionFreeTestEvidence } from "./assertion-free-test.js";
import { buildSleepInTestEvidence } from "./sleep-in-test.js";
import { buildLogicInTestEvidence } from "./logic-in-test.js";
import { buildMockEverythingEvidence } from "./mock-everything.js";
import { buildDuplicatedFixtureDriftEvidence } from "./duplicated-fixture-drift.js";
import { buildStaleFeatureFlagEvidence } from "./stale-feature-flag.js";
import { buildUnlabeledInteractiveElementEvidence } from "./unlabeled-interactive-element.js";
import { buildUnlocalizedUserStringEvidence } from "./unlocalized-user-string.js";
import { buildConsoleResidueEvidence } from "./console-residue.js";
import { buildDeepHappyPathNestingEvidence } from "./deep-happy-path-nesting.js";
import { buildBespokeCryptoConstructionEvidence } from "./bespoke-crypto-construction.js";
import { buildDrilledPropEvidence } from "./drilled-prop.js";
import { buildDuplicatedStyleObjectEvidence } from "./duplicated-style-object.js";
import { buildParaphrasedSiblingLogicEvidence } from "./paraphrased-sibling-logic.js";
import { buildStaleCommentEvidence } from "./stale-comment.js";
import { buildUnclosedHandleEvidence } from "./unclosed-handle.js";
import { buildUnverifiedClaimEvidence } from "./unverified-claim.js";
import { buildRareCaseFirstEvidence } from "./rare-case-first.js";
import { buildSideEffectingConditionalEvidence } from "./side-effecting-conditional-expression.js";
import { buildUnexplainedComplexConditionEvidence } from "./unexplained-complex-condition.js";
import { buildCleverExpressionEvidence } from "./clever-expression.js";

export type RuleEvidenceResult =
  | { handled: false }
  | { handled: true; evidence: JsonValue | undefined };

export function buildRuleEvidence(
  ruleId: string,
  candidate: Candidate,
  projectFiles: ProjectFile[],
  changes: SourceFile[] = [],
): RuleEvidenceResult {
  if (ruleId === "jev/no-hidden-input-mutation") {
    return { handled: true, evidence: buildHiddenInputMutationEvidence(candidate, projectFiles) };
  }
  if (ruleId === "jev/no-hidden-io") {
    return { handled: true, evidence: buildHiddenIoEvidence(candidate, projectFiles) };
  }
  if (ruleId === "jev/no-lossy-sentinel-return") {
    return { handled: true, evidence: buildLossySentinelReturnEvidence(candidate, projectFiles) };
  }
  if (ruleId === "jev/no-query-side-effect") {
    return { handled: true, evidence: buildQuerySideEffectEvidence(candidate, projectFiles) };
  }
  if (ruleId === "jev/no-pass-through-wrapper") {
    return { handled: true, evidence: buildPassThroughWrapperEvidence(candidate, projectFiles) };
  }
  if (ruleId === "jev/no-speculative-generality") {
    return { handled: true, evidence: buildSpeculativeGeneralityEvidence(candidate, projectFiles) };
  }
  if (ruleId === "jev/no-ad-hoc-branching") {
    return { handled: true, evidence: buildAdHocBranchingEvidence(candidate, projectFiles) };
  }
  if (ruleId === "jev/no-mixed-responsibilities") {
    return { handled: true, evidence: buildMixedResponsibilitiesEvidence(candidate, projectFiles) };
  }
  if (ruleId === "jev/no-data-clump") {
    return { handled: true, evidence: buildDataClumpEvidence(candidate, projectFiles) };
  }
  if (ruleId === "jev/no-scattered-policy") {
    return { handled: true, evidence: buildScatteredPolicyEvidence(candidate, projectFiles) };
  }
  if (ruleId === "jev/no-needless-abstraction") {
    return { handled: true, evidence: buildNeedlessAbstractionEvidence(candidate, projectFiles) };
  }
  if (ruleId === "jev/no-conditionally-valid-state") {
    return {
      handled: true,
      evidence: buildConditionallyValidStateEvidence(candidate, projectFiles),
    };
  }
  if (ruleId === "jev/no-correlated-state-booleans") {
    return {
      handled: true,
      evidence: buildCorrelatedStateBooleansEvidence(candidate, projectFiles),
    };
  }
  if (ruleId === "jev/no-unconstrained-state-string") {
    return {
      handled: true,
      evidence: buildUnconstrainedStateStringEvidence(candidate, projectFiles),
    };
  }
  if (ruleId === "jev/no-generic-magic") {
    return { handled: true, evidence: buildGenericMagicEvidence(candidate, projectFiles) };
  }
  if (ruleId === "jev/no-disproportionate-configuration") {
    return {
      handled: true,
      evidence: buildDisproportionateConfigurationEvidence(candidate, projectFiles),
    };
  }
  if (ruleId === "jev/no-avoidable-orchestration") {
    return { handled: true, evidence: buildAvoidableOrchestrationEvidence(candidate, projectFiles) };
  }
  if (ruleId === "jev/no-hidden-runtime-input") {
    return { handled: true, evidence: buildHiddenRuntimeInputEvidence(candidate, projectFiles) };
  }
  if (ruleId === "jev/no-hidden-initialization-order") {
    return {
      handled: true,
      evidence: buildHiddenInitializationOrderEvidence(candidate, projectFiles),
    };
  }
  if (ruleId === "jev/no-implicit-atomicity") {
    return { handled: true, evidence: buildImplicitAtomicityEvidence(candidate, projectFiles) };
  }
  if (ruleId === "jev/no-complexity-displacement") {
    return {
      handled: true,
      evidence: buildComplexityDisplacementEvidence(candidate, changes, projectFiles),
    };
  }
  if (ruleId === "jev/no-transport-coupled-domain") {
    return {
      handled: true,
      evidence: buildTransportCoupledDomainEvidence(candidate, projectFiles),
    };
  }
  if (ruleId === "jev/no-persistence-model-leak") {
    return {
      handled: true,
      evidence: buildPersistenceModelLeakEvidence(candidate, projectFiles),
    };
  }
  if (ruleId === "jev/no-interchangeable-domain-primitives") {
    return {
      handled: true,
      evidence: buildInterchangeableDomainPrimitivesEvidence(candidate, projectFiles),
    };
  }
  if (ruleId === "jev/no-domain-policy-in-adapter") {
    return {
      handled: true,
      evidence: buildDomainPolicyInAdapterEvidence(candidate, projectFiles),
    };
  }
  if (ruleId === "jev/no-swallowed-error") {
    return { handled: true, evidence: buildSwallowedErrorEvidence(candidate, projectFiles) };
  }
  if (ruleId === "jev/no-lossy-error-translation") {
    return {
      handled: true,
      evidence: buildLossyErrorTranslationEvidence(candidate, projectFiles),
    };
  }
  if (ruleId === "jev/no-unsafe-retry") {
    return { handled: true, evidence: buildUnsafeRetryEvidence(candidate, projectFiles) };
  }
  if (ruleId === "jev/no-hidden-partial-failure") {
    return {
      handled: true,
      evidence: buildHiddenPartialFailureEvidence(candidate, projectFiles),
    };
  }
  if (ruleId === "jev/no-foreign-mutation") {
    return { handled: true, evidence: buildForeignMutationEvidence(candidate, projectFiles) };
  }
  if (ruleId === "jev/no-temporal-call-coupling") {
    return { handled: true, evidence: buildTemporalCallCouplingEvidence(candidate, projectFiles) };
  }
  if (ruleId === "jev/no-shotgun-change") {
    return {
      handled: true,
      evidence: buildShotgunChangeEvidence(candidate, changes, projectFiles),
    };
  }
  if (ruleId === "jev/no-undocumented-contract") {
    return { handled: true, evidence: buildUndocumentedContractEvidence(candidate, projectFiles) };
  }
  if (ruleId === "jev/no-duplicated-logic") {
    return { handled: true, evidence: buildDuplicatedLogicEvidence(candidate, projectFiles) };
  }
  if (ruleId === "jev/no-type-code-dispatch") {
    return { handled: true, evidence: buildTypeCodeDispatchEvidence(candidate, projectFiles) };
  }
  if (ruleId === "jev/no-mode-flag-parameter") {
    return { handled: true, evidence: buildModeFlagParameterEvidence(candidate, projectFiles) };
  }
  if (ruleId === "jev/no-message-chain") {
    return { handled: true, evidence: buildMessageChainEvidence(candidate, projectFiles) };
  }
  if (ruleId === "jev/no-mixed-abstraction-levels") {
    return {
      handled: true,
      evidence: buildMixedAbstractionLevelsEvidence(candidate, projectFiles),
    };
  }
  if (ruleId === "jev/no-unbounded-wait") {
    return { handled: true, evidence: buildUnboundedWaitEvidence(candidate, projectFiles) };
  }
  if (ruleId === "jev/no-detached-async-work") {
    return { handled: true, evidence: buildDetachedAsyncWorkEvidence(candidate, projectFiles) };
  }
  if (ruleId === "jev/no-shared-mutable-module-state") {
    return {
      handled: true,
      evidence: buildSharedMutableModuleStateEvidence(candidate, projectFiles),
    };
  }
  if (ruleId === "jev/no-type-checker-escape") {
    return { handled: true, evidence: buildTypeCheckerEscapeEvidence(candidate, projectFiles) };
  }
  if (ruleId === "jev/no-unawaited-iteration-work") {
    return {
      handled: true,
      evidence: buildUnawaitedIterationWorkEvidence(candidate, projectFiles),
    };
  }
  if (ruleId === "jev/no-asymmetric-normalization") {
    return {
      handled: true,
      evidence: buildAsymmetricNormalizationEvidence(candidate, projectFiles),
    };
  }
  if (ruleId === "jev/no-unguarded-nullable-dereference") {
    return {
      handled: true,
      evidence: buildUnguardedNullableDereferenceEvidence(candidate, projectFiles),
    };
  }
  if (ruleId === "jev/no-falsy-absent-conflation") {
    return {
      handled: true,
      evidence: buildFalsyAbsentConflationEvidence(candidate, projectFiles),
    };
  }
  if (ruleId === "jev/no-unanchored-domain-check") {
    return {
      handled: true,
      evidence: buildUnanchoredDomainCheckEvidence(candidate, projectFiles),
    };
  }
  if (ruleId === "jev/no-contract-signature-drift") {
    return {
      handled: true,
      evidence: buildContractSignatureDriftEvidence(candidate, projectFiles),
    };
  }
  if (ruleId === "jev/no-accidental-serialization") {
    return { handled: true, evidence: buildAccidentalSerializationEvidence(candidate, projectFiles) };
  }
  if (ruleId === "jev/no-discarded-transformation") {
    return { handled: true, evidence: buildDiscardedTransformationEvidence(candidate, projectFiles) };
  }
  if (ruleId === "jev/no-load-bearing-async") {
    return { handled: true, evidence: buildLoadBearingAsyncEvidence(candidate, projectFiles) };
  }
  if (ruleId === "jev/no-untrusted-sink-input") {
    return { handled: true, evidence: buildUntrustedSinkInputEvidence(candidate, projectFiles) };
  }
  if (ruleId === "jev/no-unreleased-subscription") {
    return { handled: true, evidence: buildUnreleasedSubscriptionEvidence(candidate, projectFiles) };
  }
  if (ruleId === "jev/no-unwieldy-signature") {
    return { handled: true, evidence: buildUnwieldySignatureEvidence(candidate, projectFiles) };
  }
  if (ruleId === "jev/no-inappropriate-intimacy") {
    return { handled: true, evidence: buildInappropriateIntimacyEvidence(candidate, projectFiles) };
  }
  if (ruleId === "jev/no-anemic-type") {
    return { handled: true, evidence: buildAnemicTypeEvidence(candidate, projectFiles) };
  }
  if (ruleId === "jev/no-temporary-field") {
    return { handled: true, evidence: buildTemporaryFieldEvidence(candidate, projectFiles) };
  }
  if (ruleId === "jev/no-low-cohesion-class") {
    return { handled: true, evidence: buildLowCohesionClassEvidence(candidate, projectFiles) };
  }
  if (ruleId === "jev/no-divergent-change") {
    return {
      handled: true,
      evidence: buildDivergentChangeEvidence(candidate, changes, projectFiles),
    };
  }
  if (ruleId === "jev/no-divergent-sibling-interfaces") {
    return {
      handled: true,
      evidence: buildDivergentSiblingInterfacesEvidence(candidate, projectFiles),
    };
  }
  if (ruleId === "jev/no-refused-inheritance") {
    return { handled: true, evidence: buildRefusedInheritanceEvidence(candidate, projectFiles) };
  }
  if (ruleId === "jev/no-unnamed-parameter-object") {
    return { handled: true, evidence: buildUnnamedParameterObjectEvidence(candidate, projectFiles) };
  }
  if (ruleId === "jev/no-predictable-token") {
    return { handled: true, evidence: buildPredictableTokenEvidence(candidate, projectFiles) };
  }
  if (ruleId === "jev/no-unreachable-guard") {
    return { handled: true, evidence: buildUnreachableGuardEvidence(candidate, projectFiles) };
  }
  if (ruleId === "jev/no-adversarial-regex") {
    return { handled: true, evidence: buildAdversarialRegexEvidence(candidate, projectFiles) };
  }
  if (ruleId === "jev/no-live-credential") {
    return { handled: true, evidence: buildLiveCredentialEvidence(candidate, projectFiles) };
  }
  if (ruleId === "jev/no-unvalidated-boundary-shape") {
    return {
      handled: true,
      evidence: buildUnvalidatedBoundaryEvidence(candidate, projectFiles),
    };
  }
  if (ruleId === "jev/no-stale-binding-use") {
    return {
      handled: true,
      evidence: buildStaleBindingUseEvidence(candidate, projectFiles),
    };
  }
  if (ruleId === "jev/no-pre-gate-side-effect") {
    return {
      handled: true,
      evidence: buildPreGateSideEffectEvidence(candidate, projectFiles),
    };
  }
  if (ruleId === "jev/no-inverted-authorization-predicate") {
    return {
      handled: true,
      evidence: buildInvertedAuthorizationPredicateEvidence(candidate, projectFiles),
    };
  }
  if (ruleId === "jev/no-hardcoded-config-shadow") {
    return {
      handled: true,
      evidence: buildHardcodedConfigShadowEvidence(candidate, projectFiles),
    };
  }
  if (ruleId === "jev/no-sibling-identifier-swap") {
    return {
      handled: true,
      evidence: buildSiblingIdentifierSwapEvidence(candidate, projectFiles),
    };
  }
  if (ruleId === "jev/no-output-argument") {
    return { handled: true, evidence: buildOutputArgumentEvidence(candidate, projectFiles) };
  }
  if (ruleId === "jev/no-contextless-error") {
    return { handled: true, evidence: buildContextlessErrorEvidence(candidate, projectFiles) };
  }
  if (ruleId === "jev/no-unchecked-precondition") {
    return { handled: true, evidence: buildUncheckedPreconditionEvidence(candidate, projectFiles) };
  }
  if (ruleId === "jev/no-unenforced-warning-comment") {
    return { handled: true, evidence: buildUnenforcedWarningCommentEvidence(candidate, projectFiles) };
  }
  if (ruleId === "jev/no-table-shaped-conditional") {
    return { handled: true, evidence: buildTableConditionalEvidence(candidate, projectFiles) };
  }
  if (ruleId === "jev/no-sequential-step-soup") {
    return { handled: true, evidence: buildSequentialStepSoupEvidence(candidate, projectFiles) };
  }
  if (ruleId === "jev/no-mirrored-derived-state") {
    return { handled: true, evidence: buildMirroredDerivedStateEvidence(candidate, projectFiles) };
  }
  if (ruleId === "jev/no-construction-in-use") {
    return { handled: true, evidence: buildConstructionInUseEvidence(candidate, projectFiles) };
  }
  if (ruleId === "jev/no-retry-storm-shape") {
    return { handled: true, evidence: buildRetryStormEvidence(candidate, projectFiles) };
  }
  if (ruleId === "jev/no-unbounded-accumulation") {
    return {
      handled: true,
      evidence: buildUnboundedAccumulationEvidence(candidate, projectFiles),
    };
  }
  if (ruleId === "jev/no-call-in-loop-persistence") {
    return {
      handled: true,
      evidence: buildCallInLoopPersistenceEvidence(candidate, projectFiles),
    };
  }
  if (ruleId === "jev/no-unbounded-parallel-fanout") {
    return {
      handled: true,
      evidence: buildUnboundedParallelFanoutEvidence(candidate, projectFiles),
    };
  }
  if (ruleId === "jev/no-concurrent-shared-mutation") {
    return {
      handled: true,
      evidence: buildConcurrentSharedMutationEvidence(candidate, projectFiles),
    };
  }
  if (ruleId === "jev/no-sensitive-data-in-log") {
    return { handled: true, evidence: buildSensitiveDataInLogEvidence(candidate, projectFiles) };
  }
  if (ruleId === "jev/no-unsafe-redirect-target") {
    return { handled: true, evidence: buildUnsafeRedirectTargetEvidence(candidate, projectFiles) };
  }
  if (ruleId === "jev/no-overbroad-origin-trust") {
    return { handled: true, evidence: buildOverbroadOriginTrustEvidence(candidate, projectFiles) };
  }
  if (ruleId === "jev/no-path-traversal-join") {
    return { handled: true, evidence: buildPathTraversalJoinEvidence(candidate, projectFiles) };
  }
  if (ruleId === "jev/no-phantom-member-access") {
    return {
      handled: true,
      evidence: buildPhantomMemberAccessEvidence(candidate, projectFiles),
    };
  }
  if (ruleId === "jev/no-laundered-absence") {
    return {
      handled: true,
      evidence: buildLaunderedAbsenceEvidence(candidate, projectFiles),
    };
  }
  if (ruleId === "jev/no-convention-breaking-addition") {
    return {
      handled: true,
      evidence: buildConventionBreakingAdditionEvidence(candidate, projectFiles),
    };
  }
  if (ruleId === "jev/no-repeated-handler-preamble") {
    return {
      handled: true,
      evidence: buildRepeatedHandlerPreambleEvidence(candidate, projectFiles),
    };
  }
  if (ruleId === "jev/no-non-narrowing-guard") {
    return {
      handled: true,
      evidence: buildNonNarrowingGuardEvidence(candidate, projectFiles),
    };
  }
  if (ruleId === "jev/no-excess-context-parameter") {
    return {
      handled: true,
      evidence: buildExcessContextParameterEvidence(candidate, projectFiles),
    };
  }
  if (ruleId === "jev/no-shallow-convenience-layer") {
    return {
      handled: true,
      evidence: buildShallowConvenienceLayerEvidence(candidate, projectFiles),
    };
  }
  if (ruleId === "jev/no-prototype-in-production") {
    return {
      handled: true,
      evidence: buildPrototypeInProductionEvidence(candidate, projectFiles),
    };
  }
  if (ruleId === "jev/no-hidden-loop-exit") {
    return { handled: true, evidence: buildHiddenLoopExitEvidence(candidate, projectFiles) };
  }
  if (ruleId === "jev/no-inconsistent-error-contract") {
    return {
      handled: true,
      evidence: buildInconsistentErrorContractEvidence(candidate, projectFiles),
    };
  }
  if (ruleId === "jev/no-breaking-export-reshape") {
    return {
      handled: true,
      evidence: buildBreakingExportEvidence(candidate, changes, projectFiles),
    };
  }
  if (ruleId === "jev/no-positional-extension-drift") {
    return {
      handled: true,
      evidence: buildPositionalExtensionDriftEvidence(candidate, projectFiles),
    };
  }
  if (ruleId === "jev/no-mixed-absence-convention") {
    return {
      handled: true,
      evidence: buildMixedAbsenceConventionEvidence(candidate, projectFiles),
    };
  }
  if (ruleId === "jev/no-shared-mutable-default") {
    return {
      handled: true,
      evidence: buildSharedMutableDefaultEvidence(candidate, projectFiles),
    };
  }
  if (ruleId === "jev/no-blocking-event-loop-call") {
    return { handled: true, evidence: buildBlockingEventLoopCallEvidence(candidate, projectFiles) };
  }
  if (ruleId === "jev/no-unguarded-async-init") {
    return { handled: true, evidence: buildUnguardedAsyncInitEvidence(candidate, projectFiles) };
  }
  if (ruleId === "jev/no-promise-combinator-mismatch") {
    return {
      handled: true,
      evidence: buildPromiseCombinatorMismatchEvidence(candidate, projectFiles),
    };
  }
  if (ruleId === "jev/no-orphaned-timer") {
    return { handled: true, evidence: buildOrphanedTimerEvidence(candidate, projectFiles) };
  }
  if (ruleId === "jev/no-unsynchronized-shared-memory") {
    return {
      handled: true,
      evidence: buildUnsynchronizedSharedMemoryEvidence(candidate, projectFiles),
    };
  }
  if (ruleId === "jev/no-timezone-naive-arithmetic") {
    return {
      handled: true,
      evidence: buildTimezoneNaiveArithmeticEvidence(candidate, projectFiles),
    };
  }
  if (ruleId === "jev/no-floating-money-arithmetic") {
    return {
      handled: true,
      evidence: buildFloatingMoneyArithmeticEvidence(candidate, projectFiles),
    };
  }
  if (ruleId === "jev/no-offset-pagination-drift") {
    return {
      handled: true,
      evidence: buildOffsetPaginationDriftEvidence(candidate, projectFiles),
    };
  }
  if (ruleId === "jev/no-unit-scale-mismatch") {
    return {
      handled: true,
      evidence: buildUnitScaleMismatchEvidence(candidate, projectFiles),
    };
  }
  if (ruleId === "jev/no-truncating-numeric-parse") {
    return {
      handled: true,
      evidence: buildTruncatingNumericParseEvidence(candidate, projectFiles),
    };
  }
  if (ruleId === "jev/no-locale-date-serialization") {
    return {
      handled: true,
      evidence: buildLocaleDateSerializationEvidence(candidate, projectFiles),
    };
  }
  if (ruleId === "jev/no-overload-resolution-ambiguity") {
    return {
      handled: true,
      evidence: buildOverloadResolutionAmbiguityEvidence(candidate, projectFiles),
    };
  }
  if (ruleId === "jev/no-sync-async-sibling-ambiguity") {
    return {
      handled: true,
      evidence: buildSyncAsyncSiblingAmbiguityEvidence(candidate, projectFiles),
    };
  }
  if (ruleId === "jev/no-leaky-internal-export") {
    return {
      handled: true,
      evidence: buildLeakyInternalExportEvidence(candidate, projectFiles),
    };
  }
  if (ruleId === "jev/no-weak-crypto-primitive") {
    return { handled: true, evidence: buildWeakCryptoPrimitiveEvidence(candidate, projectFiles) };
  }
  if (ruleId === "jev/no-disabled-tls-verification") {
    return { handled: true, evidence: buildDisabledTlsVerificationEvidence(candidate, projectFiles) };
  }
  if (ruleId === "jev/no-dynamic-code-execution") {
    return { handled: true, evidence: buildDynamicCodeExecutionEvidence(candidate, projectFiles) };
  }
  if (ruleId === "jev/no-locale-blind-ordering") {
    return { handled: true, evidence: buildLocaleBlindOrderingEvidence(candidate, projectFiles) };
  }
  if (ruleId === "jev/no-cascading-fallback") {
    return { handled: true, evidence: buildCascadingFallbackEvidence(candidate, projectFiles) };
  }
  if (ruleId === "jev/no-silent-queue-drop") {
    return { handled: true, evidence: buildSilentQueueDropEvidence(candidate, projectFiles) };
  }
  if (ruleId === "jev/no-missing-shutdown-drain") {
    return {
      handled: true,
      evidence: buildMissingShutdownDrainEvidence(candidate, projectFiles),
    };
  }
  if (ruleId === "jev/no-missing-health-signal") {
    return {
      handled: true,
      evidence: buildMissingHealthSignalEvidence(candidate, projectFiles),
    };
  }
  if (ruleId === "jev/no-deployment-coupled-assumption") {
    return {
      handled: true,
      evidence: buildDeploymentCoupledAssumptionEvidence(candidate, projectFiles),
    };
  }
  if (ruleId === "jev/no-assertion-free-test") {
    return { handled: true, evidence: buildAssertionFreeTestEvidence(candidate, projectFiles) };
  }
  if (ruleId === "jev/no-sleep-in-test") {
    return { handled: true, evidence: buildSleepInTestEvidence(candidate, projectFiles) };
  }
  if (ruleId === "jev/no-logic-in-test") {
    return { handled: true, evidence: buildLogicInTestEvidence(candidate, projectFiles) };
  }
  if (ruleId === "jev/no-mock-everything") {
    return { handled: true, evidence: buildMockEverythingEvidence(candidate, projectFiles) };
  }
  if (ruleId === "jev/no-duplicated-fixture-drift") {
    return {
      handled: true,
      evidence: buildDuplicatedFixtureDriftEvidence(candidate, projectFiles),
    };
  }
  if (ruleId === "jev/no-stale-feature-flag") {
    return { handled: true, evidence: buildStaleFeatureFlagEvidence(candidate, projectFiles) };
  }
  if (ruleId === "jev/no-unlabeled-interactive-element") {
    return {
      handled: true,
      evidence: buildUnlabeledInteractiveElementEvidence(candidate, projectFiles),
    };
  }
  if (ruleId === "jev/no-unlocalized-user-string") {
    return {
      handled: true,
      evidence: buildUnlocalizedUserStringEvidence(candidate, projectFiles),
    };
  }
  if (ruleId === "jev/no-console-residue") {
    return { handled: true, evidence: buildConsoleResidueEvidence(candidate, projectFiles) };
  }
  if (ruleId === "jev/no-deep-happy-path-nesting") {
    return {
      handled: true,
      evidence: buildDeepHappyPathNestingEvidence(candidate, projectFiles),
    };
  }
  if (ruleId === "jev/no-unverified-claim") {
    return {
      handled: true,
      evidence: buildUnverifiedClaimEvidence(candidate, projectFiles),
    };
  }
  if (ruleId === "jev/no-drilled-prop") {
    return { handled: true, evidence: buildDrilledPropEvidence(candidate, projectFiles) };
  }
  if (ruleId === "jev/no-stale-comment") {
    return { handled: true, evidence: buildStaleCommentEvidence(candidate, projectFiles, changes) };
  }
  if (ruleId === "jev/no-paraphrased-sibling-logic") {
    return { handled: true, evidence: buildParaphrasedSiblingLogicEvidence(candidate, projectFiles) };
  }
  if (ruleId === "jev/no-unclosed-handle") {
    return { handled: true, evidence: buildUnclosedHandleEvidence(candidate, projectFiles) };
  }
  if (ruleId === "jev/no-bespoke-crypto-construction") {
    return { handled: true, evidence: buildBespokeCryptoConstructionEvidence(candidate, projectFiles) };
  }
  if (ruleId === "jev/no-duplicated-style-object") {
    return { handled: true, evidence: buildDuplicatedStyleObjectEvidence(candidate, projectFiles) };
  }
  if (ruleId === "jev/no-rare-case-first") {
    return { handled: true, evidence: buildRareCaseFirstEvidence(candidate, projectFiles) };
  }
  if (ruleId === "jev/no-side-effecting-conditional-expression") {
    return { handled: true, evidence: buildSideEffectingConditionalEvidence(candidate, projectFiles) };
  }
  if (ruleId === "jev/no-unexplained-complex-condition") {
    return { handled: true, evidence: buildUnexplainedComplexConditionEvidence(candidate, projectFiles) };
  }
  if (ruleId === "jev/no-clever-expression") {
    return { handled: true, evidence: buildCleverExpressionEvidence(candidate, projectFiles) };
  }
  return { handled: false };
}
