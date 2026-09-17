import type { JsonValue } from "@typesafe-ai/sdk";
import type { Candidate, ProjectFile, SourceFile } from "../types.js";
import { buildAdHocBranchingEvidence } from "./ad-hoc-branching.js";
import { buildAvoidableOrchestrationEvidence } from "./avoidable-orchestration.js";
import { buildComplexityDisplacementEvidence } from "./complexity-displacement.js";
import { buildConditionallyValidStateEvidence } from "./conditionally-valid-state.js";
import { buildCorrelatedStateBooleansEvidence } from "./correlated-state-booleans.js";
import { buildDataClumpEvidence } from "./data-clump.js";
import { buildDisproportionateConfigurationEvidence } from "./disproportionate-configuration.js";
import { buildDomainPolicyInAdapterEvidence } from "./domain-policy-in-adapter.js";
import { buildGenericMagicEvidence } from "./generic-magic.js";
import { buildHiddenInputMutationEvidence } from "./hidden-input-mutation.js";
import { buildHiddenIoEvidence } from "./hidden-io.js";
import { buildHiddenInitializationOrderEvidence } from "./hidden-initialization-order.js";
import { buildHiddenRuntimeInputEvidence } from "./hidden-runtime-input.js";
import { buildImplicitAtomicityEvidence } from "./implicit-atomicity.js";
import { buildInterchangeableDomainPrimitivesEvidence } from "./interchangeable-domain-primitives.js";
import { buildLossySentinelReturnEvidence } from "./lossy-sentinel-return.js";
import { buildMixedResponsibilitiesEvidence } from "./mixed-responsibilities.js";
import { buildNeedlessAbstractionEvidence } from "./needless-abstraction.js";
import { buildPassThroughWrapperEvidence } from "./pass-through-wrapper.js";
import { buildPersistenceModelLeakEvidence } from "./persistence-model-leak.js";
import { buildQuerySideEffectEvidence } from "./query-side-effect.js";
import { buildScatteredPolicyEvidence } from "./scattered-policy.js";
import { buildSpeculativeGeneralityEvidence } from "./speculative-generality.js";
import { buildSwallowedErrorEvidence } from "./swallowed-error.js";
import { buildTransportCoupledDomainEvidence } from "./transport-coupled-domain.js";
import { buildUnconstrainedStateStringEvidence } from "./unconstrained-state-string.js";

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
  return { handled: false };
}
