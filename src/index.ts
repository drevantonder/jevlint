export {
  authRejectionMessage,
  CredentialRejectedError,
  defaultAuthIO,
  ENV_VAR_NAME,
  installShellKey,
  isAuthFailure,
  MISSING_CREDENTIAL_MESSAGE,
  promptForApiKey,
  removeShellKey,
  resolveCredential,
  resolveCredentialWithIO,
  SETUP_CANCELLED_MESSAGE,
  SETUP_NON_TTY_MESSAGE,
  SetupCancelledError,
  SHELL_MARKER,
  SHELL_RC_FILES,
  shellExportLine,
  STORED_REMOVED_MESSAGE,
} from "./auth.js";
export type {
  AuthIO,
  CredentialSource,
  PromptStdin,
  ResolvedCredential,
  ShellWriteResult,
  StderrWriter,
} from "./auth.js";
export {
  analyzeAuditWithFailures,
  analyzeChanges,
  analyzeChangesWithFailures,
  analyzeFile,
  analyzeFileWithFailures,
  analyzeModules,
  analyzeModulesWithFailures,
  AUDIT_UNSCORED_REASON,
  EVALUATION_REQUEST_BUDGET_CHARS,
  sortAbstentions,
  sortJudgments,
} from "./analyze.js";
export type { AnalyzeAuditInput, AnalyzeAuditResult } from "./analyze.js";
export { CachedEvaluator } from "./cache.js";
export type { CacheMode, CacheStatistics, CachedEvaluatorOptions, EvaluatorIdentity } from "./cache.js";
export { extractCandidates, filterCandidatesByChangedLines } from "./candidates.js";
export { parseChangedLineRanges } from "./changed-lines.js";
export { defaultConfig, defineConfig, definePlugin, defineRule, loadConfig } from "./config.js";
export type {
  CustomEvidenceBuilder,
  CustomRuleDescriptor,
  PluginContainer,
  PluginEntry,
} from "./types.js";
export {
  createReviewReport,
  DEFAULT_DISPLAY_LIMIT,
  formatCoverage,
  formatGithub,
  formatJson,
  formatText,
  MAX_REPORTED_FAILURES,
} from "./format.js";
export type { CreateReviewReportInput } from "./format.js";
export {
  artifactFileName,
  createFileArtifact,
  writeFileArtifact,
  writeSummaryArtifact,
} from "./out-dir.js";
export type { DisplayOptions } from "./types.js";
export type {
  AuditCoverage,
  FileReviewArtifact,
  OmittedByKind,
  OmittedByRule,
  UnscoredRule,
} from "./types.js";
export { collectChangedFiles, collectRepositoryFiles, repositoryCacheContext } from "./git.js";
export { buildAdHocBranchingEvidence } from "./evidence/ad-hoc-branching.js";
export { buildAnemicTypeEvidence } from "./evidence/anemic-type.js";
export { buildAvoidableOrchestrationEvidence } from "./evidence/avoidable-orchestration.js";
export { buildComplexityDisplacementEvidence } from "./evidence/complexity-displacement.js";
export { buildConditionallyValidStateEvidence } from "./evidence/conditionally-valid-state.js";
export { buildCorrelatedStateBooleansEvidence } from "./evidence/correlated-state-booleans.js";
export { buildDataClumpEvidence } from "./evidence/data-clump.js";
export { buildDetachedAsyncWorkEvidence } from "./evidence/detached-async-work.js";
export { buildDisproportionateConfigurationEvidence } from "./evidence/disproportionate-configuration.js";
export { buildDomainPolicyInAdapterEvidence } from "./evidence/domain-policy-in-adapter.js";
export { buildGenericMagicEvidence } from "./evidence/generic-magic.js";
export { buildHiddenInputMutationEvidence } from "./evidence/hidden-input-mutation.js";
export { buildHiddenIoEvidence } from "./evidence/hidden-io.js";
export { buildHiddenPartialFailureEvidence } from "./evidence/hidden-partial-failure.js";
export { buildHiddenInitializationOrderEvidence } from "./evidence/hidden-initialization-order.js";
export { buildHiddenRuntimeInputEvidence } from "./evidence/hidden-runtime-input.js";
export { buildImplicitAtomicityEvidence } from "./evidence/implicit-atomicity.js";
export { buildInappropriateIntimacyEvidence } from "./evidence/inappropriate-intimacy.js";
export { buildInterchangeableDomainPrimitivesEvidence } from "./evidence/interchangeable-domain-primitives.js";
export { buildLossyErrorTranslationEvidence } from "./evidence/lossy-error-translation.js";
export { buildLossySentinelReturnEvidence } from "./evidence/lossy-sentinel-return.js";
export { buildMixedResponsibilitiesEvidence } from "./evidence/mixed-responsibilities.js";
export { buildNeedlessAbstractionEvidence } from "./evidence/needless-abstraction.js";
export { buildPassThroughWrapperEvidence } from "./evidence/pass-through-wrapper.js";
export { buildPersistenceModelLeakEvidence } from "./evidence/persistence-model-leak.js";
export { buildQuerySideEffectEvidence } from "./evidence/query-side-effect.js";
export { buildScatteredPolicyEvidence } from "./evidence/scattered-policy.js";
export { buildSharedMutableModuleStateEvidence } from "./evidence/shared-mutable-module-state.js";
export { buildSpeculativeGeneralityEvidence } from "./evidence/speculative-generality.js";
export { buildSwallowedErrorEvidence } from "./evidence/swallowed-error.js";
export { buildTemporaryFieldEvidence } from "./evidence/temporary-field.js";
export { buildTransportCoupledDomainEvidence } from "./evidence/transport-coupled-domain.js";
export { buildTypeCheckerEscapeEvidence } from "./evidence/type-checker-escape.js";
export { buildUnboundedWaitEvidence } from "./evidence/unbounded-wait.js";
export { buildUnconstrainedStateStringEvidence } from "./evidence/unconstrained-state-string.js";
