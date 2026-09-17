import type { EntryType, JsonValue, NoulQuestion } from "@typesafe-ai/sdk";

export type CandidateKind = "comment" | "function" | "abstraction" | "change";
export type Severity = "error" | "warning";

export interface LineRange {
  start: number;
  end: number;
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
  threshold: number;
  severity: Severity;
  message: string;
}

export type RuleSetting = RuleConfig | "off";

export interface UserConfig {
  rules?: Record<string, RuleSetting>;
}

export interface JevLintConfig {
  rules: Record<string, RuleConfig>;
}

export interface EvaluationCandidate {
  id: string;
  kind: CandidateKind;
  source: string;
  nearbySource: string;
  startLine: number;
  endLine: number;
  evidence?: Record<string, JsonValue>;
}

export interface EvaluationState {
  file: {
    path: string;
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

export interface Diagnostic {
  filePath: string;
  line: number;
  column: number;
  endLine: number;
  endColumn: number;
  severity: Severity;
  ruleId: string;
  message: string;
  probability: number;
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
