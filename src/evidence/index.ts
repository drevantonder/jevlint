import type { JsonValue } from "@typesafe-ai/sdk";
import type { Candidate, ProjectFile, SourceFile } from "../types.js";
import { buildAccidentalSerializationEvidence } from "./accidental-serialization.js";
import { buildAdHocBranchingEvidence } from "./ad-hoc-branching.js";
import { buildAsymmetricNormalizationEvidence } from "./asymmetric-normalization.js";
import { buildAvoidableOrchestrationEvidence } from "./avoidable-orchestration.js";
import { buildComplexityDisplacementEvidence } from "./complexity-displacement.js";
import { buildConditionallyValidStateEvidence } from "./conditionally-valid-state.js";
import { buildCorrelatedStateBooleansEvidence } from "./correlated-state-booleans.js";
import { buildContractSignatureDriftEvidence } from "./contract-signature-drift.js";
import { buildDataClumpEvidence } from "./data-clump.js";
import { buildDetachedAsyncWorkEvidence } from "./detached-async-work.js";
import { buildDisproportionateConfigurationEvidence } from "./disproportionate-configuration.js";
import { buildDiscardedTransformationEvidence } from "./discarded-transformation.js";
import { buildDomainPolicyInAdapterEvidence } from "./domain-policy-in-adapter.js";
import { buildDuplicatedLogicEvidence } from "./duplicated-logic.js";
import { buildForeignMutationEvidence } from "./foreign-mutation.js";
import { buildGenericMagicEvidence } from "./generic-magic.js";
import { buildFalsyAbsentConflationEvidence } from "./falsy-absent-conflation.js";
import { buildHiddenInputMutationEvidence } from "./hidden-input-mutation.js";
import { buildHiddenIoEvidence } from "./hidden-io.js";
import { buildHiddenPartialFailureEvidence } from "./hidden-partial-failure.js";
import { buildHiddenInitializationOrderEvidence } from "./hidden-initialization-order.js";
import { buildHiddenRuntimeInputEvidence } from "./hidden-runtime-input.js";
import { buildImplicitAtomicityEvidence } from "./implicit-atomicity.js";
import { buildInterchangeableDomainPrimitivesEvidence } from "./interchangeable-domain-primitives.js";
import { buildLossyErrorTranslationEvidence } from "./lossy-error-translation.js";
import { buildLoadBearingAsyncEvidence } from "./load-bearing-async.js";
import { buildLossySentinelReturnEvidence } from "./lossy-sentinel-return.js";
import { buildMessageChainEvidence } from "./message-chain.js";
import { buildMixedAbstractionLevelsEvidence } from "./mixed-abstraction-levels.js";
import { buildMixedResponsibilitiesEvidence } from "./mixed-responsibilities.js";
import { buildModeFlagParameterEvidence } from "./mode-flag-parameter.js";
import { buildNeedlessAbstractionEvidence } from "./needless-abstraction.js";
import { buildPassThroughWrapperEvidence } from "./pass-through-wrapper.js";
import { buildPersistenceModelLeakEvidence } from "./persistence-model-leak.js";
import { buildQuerySideEffectEvidence } from "./query-side-effect.js";
import { buildScatteredPolicyEvidence } from "./scattered-policy.js";
import { buildSharedMutableModuleStateEvidence } from "./shared-mutable-module-state.js";
import { buildShotgunChangeEvidence } from "./shotgun-change.js";
import { buildSpeculativeGeneralityEvidence } from "./speculative-generality.js";
import { buildSwallowedErrorEvidence } from "./swallowed-error.js";
import { buildTemporalCallCouplingEvidence } from "./temporal-call-coupling.js";
import { buildTransportCoupledDomainEvidence } from "./transport-coupled-domain.js";
import { buildTypeCheckerEscapeEvidence } from "./type-checker-escape.js";
import { buildTypeCodeDispatchEvidence } from "./type-code-dispatch.js";
import { buildUnanchoredDomainCheckEvidence } from "./unanchored-domain-check.js";
import { buildUnawaitedIterationWorkEvidence } from "./unawaited-iteration-work.js";
import { buildUnboundedWaitEvidence } from "./unbounded-wait.js";
import { buildUnconstrainedStateStringEvidence } from "./unconstrained-state-string.js";
import { buildUndocumentedContractEvidence } from "./undocumented-contract.js";
import { buildUnguardedNullableDereferenceEvidence } from "./unguarded-nullable-dereference.js";
import { buildUnreleasedSubscriptionEvidence } from "./unreleased-subscription.js";
import { buildUnsafeRetryEvidence } from "./unsafe-retry.js";
import { buildUntrustedSinkInputEvidence } from "./untrusted-sink-input.js";

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
  return { handled: false };
}
