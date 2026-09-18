import type { EntryType, JsonValue, NoulQuestion } from "@typesafe-ai/sdk";

export type CandidateKind = "comment" | "function" | "abstraction" | "change" | "module";

export interface LineRange {
  start: number;
  end: number;
}

export interface SourcePosition {
  line: number;
  column: number;
}

export interface SourceSpan {
  start: SourcePosition;
  end: SourcePosition;
}

export interface Candidate {
  id: string;
  kind: CandidateKind;
  filePath: string;
  source: string;
  start: number;
  end: number;
  startLine: number;
  startColumn: number;
  endLine: number;
  endColumn: number;
}

export interface RuleQuestion {
  instructions: EntryType;
  criteria?: NoulQuestion["criteria"];
}

export interface RuleConfig {
  scope: CandidateKind;
  question: RuleQuestion;
  message: string;
}

export type RuleSetting = RuleConfig | "off";

export interface PluginEntry {
  name: string;
  specifier: string;
}

export type CustomEvidenceBuilder = (
  candidate: Candidate,
  projectFiles: ProjectFile[],
  changes: SourceFile[],
) => JsonValue | undefined;

export interface CustomRuleDescriptor {
  name: string;
  scope: CandidateKind;
  question: RuleQuestion;
  message: string;
  buildEvidence: CustomEvidenceBuilder;
}

export interface PluginContainer {
  name?: string;
  rules: Record<string, CustomRuleDescriptor>;
}

export interface UserConfig {
  plugins?: PluginEntry[];
  rules?: Record<string, RuleSetting>;
}

export interface JevLintConfig {
  rules: Record<string, RuleConfig>;
  customEvidence?: Record<string, CustomEvidenceBuilder>;
}

export interface EvaluationCandidate {
  id: string;
  kind: CandidateKind;
  source: string;
  nearbySource?: string;
  startLine: number;
  endLine: number;
  evidence?: Record<string, JsonValue>;
}

export interface EvaluationState {
  file: {
    path: string;
    source?: string;
  };
  candidates: EvaluationCandidate[];
}

export interface EvaluationRequest {
  state: EvaluationState;
  questions: Record<string, NoulQuestion>;
}

export interface Evaluator {
  evaluate(request: EvaluationRequest): Promise<Record<string, number>>;
}

export interface EvaluationFailure {
  filePath: string;
  candidateIds: string[];
  ruleIds: string[];
  questionCount: number;
  message: string;
}

export interface StructuralAbstentionCount {
  ruleId: string;
  candidateKind: CandidateKind;
  count: number;
}

export interface EvaluationStatistics {
  requests: number;
  questions: number;
}

export interface AnalysisResult {
  judgments: Judgment[];
  abstentions: StructuralAbstentionCount[];
  failures: EvaluationFailure[];
  statistics: EvaluationStatistics;
}

export interface Judgment {
  ruleId: string;
  message: string;
  probability: number;
  filePath: string;
  span: SourceSpan;
  candidateKind: CandidateKind;
  evidence: JsonValue | null;
}

export interface ReviewSummary {
  evaluated: number;
  displayed: number;
  abstained: number;
  failed: number;
  complete: boolean;
}

export interface ReviewFailureSummary {
  total: number;
  omitted: number;
  items: EvaluationFailure[];
}

export interface ReviewStatistics {
  evaluation: EvaluationStatistics;
  cache?: {
    hits: number;
    misses: number;
    writes: number;
    recoveries: number;
    errors: number;
    liveRequests: number;
  };
}

export interface UnscoredRule {
  ruleId: string;
  scope: CandidateKind;
  reason: string;
}

export interface OmittedByKind {
  kind: CandidateKind;
  omitted: number;
}

export interface OmittedByRule {
  ruleId: string;
  omitted: number;
}

export interface AuditCoverage {
  filesEnumerated: number;
  filesScored: number;
  filesOmitted: number;
  candidatesEnumerated: number;
  candidatesScored: number;
  questionsPrepared: number;
  questionsAsked: number;
  maxQuestions: number | null;
  evidenceBudgetMs: number | null;
  dryRun: boolean;
  omittedByKind: OmittedByKind[];
  omittedByRule: OmittedByRule[];
  unscoredRules: UnscoredRule[];
  truncatedEvidence: number;
  complete: boolean;
}

export interface DisplayOptions {
  minScore?: number;
  limit?: number;
}

export interface ReviewReport {
  version: 1;
  summary: ReviewSummary;
  judgments: Judgment[];
  display: DisplayOptions;
  abstentions: StructuralAbstentionCount[];
  failures: ReviewFailureSummary;
  statistics: ReviewStatistics;
  coverage?: AuditCoverage;
}

export interface FileReviewArtifact {
  version: 1;
  filePath: string;
  summary: {
    evaluated: number;
    abstained: number;
  };
  judgments: Judgment[];
  abstentions: StructuralAbstentionCount[];
}

export interface SourceFile {
  filePath: string;
  source: string;
  oldSource: string | null;
  changedLines: LineRange[];
}

export interface ProjectFile {
  filePath: string;
  source: string;
}
