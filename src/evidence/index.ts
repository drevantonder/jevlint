import type { JsonValue } from "@typesafe-ai/sdk";
import type { Candidate, ProjectFile, SourceFile } from "../types.js";
import { buildAdHocBranchingEvidence } from "./ad-hoc-branching.js";
import { buildAvoidableOrchestrationEvidence } from "./avoidable-orchestration.js";
import { buildComplexityDisplacementEvidence } from "./complexity-displacement.js";
import { buildConditionallyValidStateEvidence } from "./conditionally-valid-state.js";
import { buildCorrelatedStateBooleansEvidence } from "./correlated-state-booleans.js";
import { buildDisproportionateConfigurationEvidence } from "./disproportionate-configuration.js";
import { buildGenericMagicEvidence } from "./generic-magic.js";
import { buildHiddenInputMutationEvidence } from "./hidden-input-mutation.js";
import { buildHiddenIoEvidence } from "./hidden-io.js";
import { buildNeedlessAbstractionEvidence } from "./needless-abstraction.js";
import { buildPassThroughWrapperEvidence } from "./pass-through-wrapper.js";
import { buildQuerySideEffectEvidence } from "./query-side-effect.js";
import { buildSpeculativeGeneralityEvidence } from "./speculative-generality.js";
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
  if (ruleId === "jev/no-complexity-displacement") {
    return {
      handled: true,
      evidence: buildComplexityDisplacementEvidence(candidate, changes, projectFiles),
    };
  }
  return { handled: false };
}
