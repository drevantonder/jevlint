import type { JsonValue, NoulQuestion } from "@typesafe-ai/sdk";
import { extractCandidates, filterCandidatesByChangedLines } from "./candidates.js";
import { deduplicateDiagnostics } from "./deduplicate.js";
import { buildRuleEvidence } from "./evidence/index.js";
import type {
  AnalysisResult,
  Candidate,
  Diagnostic,
  EvaluationCandidate,
  EvaluationFailure,
  EvaluationRequest,
  Evaluator,
  JevLintConfig,
  LineRange,
  ProjectFile,
  RuleConfig,
  SourceFile,
} from "./types.js";

export const EVALUATION_REQUEST_BUDGET_CHARS = 48_000;
const MAX_QUESTIONS_PER_REQUEST = 24;
const MODULE_SOURCE_LIMIT = 16_000;
const FAILURE_MESSAGE_LIMIT = 500;
const EVALUATION_SCHEMA = "jevlint-semantic-judgment-v1";

export interface AnalyzeFileInput {
  filePath: string;
  source: string;
  changedLines: LineRange[];
  config: JevLintConfig;
  projectFiles?: ProjectFile[];
}

export interface AnalyzeChangesInput {
  changes: SourceFile[];
  config: JevLintConfig;
  projectFiles: ProjectFile[];
}

interface AnalyzeCandidatesInput {
  filePath: string;
  source: string;
  candidates: Candidate[];
  config: JevLintConfig;
  projectFiles: ProjectFile[];
  changes: SourceFile[];
}

interface PreparedQuestion {
  candidate: Candidate;
  evaluationCandidate: EvaluationCandidate;
  ruleId: string;
  rule: RuleConfig;
  evidence?: JsonValue;
  moduleSource?: string;
}

interface PendingQuestion {
  id: string;
  prepared: PreparedQuestion;
}

interface BuiltRequest {
  request: EvaluationRequest;
  pending: PendingQuestion[];
}

interface QuestionInstructions {
  [key: string]: JsonValue;
  schema: typeof EVALUATION_SCHEMA;
  ruleId: string;
  question: RuleConfig["question"]["instructions"];
  inspect: string;
  context: string;
  evidence: string | null;
}

interface CompactedEvidence {
  evidence: JsonValue;
  moduleSource?: string;
}

function normalizeSource(source: string): string {
  return source.replaceAll("\r\n", "\n").replaceAll("\r", "\n");
}

function nearbySource(source: string, candidate: Candidate): string | undefined {
  if (candidate.kind === "function" || candidate.kind === "change") return undefined;
  const lines = source.split("\n");
  const start = Math.max(0, candidate.startLine - 2);
  const end = Math.min(lines.length, candidate.endLine + 3);
  return lines.slice(start, end).join("\n");
}

function evaluationCandidate(source: string, candidate: Candidate): EvaluationCandidate {
  const nearby = nearbySource(source, candidate);
  const result: EvaluationCandidate = {
    id: candidate.id,
    kind: candidate.kind,
    source: normalizeSource(candidate.source),
    startLine: candidate.startLine,
    endLine: candidate.endLine,
  };
  if (nearby !== undefined) result.nearbySource = normalizeSource(nearby);
  return result;
}

function compactEvidence(evidence: JsonValue): CompactedEvidence {
  // SAFETY: Every bundled evidence provider returns an object with named evidence sections.
  const compacted = structuredClone(evidence) as Record<string, JsonValue>;
  let moduleSource: string | undefined;
  for (const key of ["abstraction", "configuration", "function"]) {
    // SAFETY: These named sections are objects in their provider contracts.
    const context = compacted[key] as Record<string, JsonValue> | undefined;
    if (!context) continue;
    const contextModuleSource = context["moduleSource"];
    if (contextModuleSource !== undefined) {
      moduleSource ??= String(contextModuleSource).slice(0, MODULE_SOURCE_LIMIT);
      delete context["moduleSource"];
    }
    delete context["source"];
  }
  const result: CompactedEvidence = { evidence: compacted };
  if (moduleSource !== undefined) result.moduleSource = moduleSource;
  return result;
}

function prepareQuestions(input: AnalyzeCandidatesInput): PreparedQuestion[] {
  const prepared: PreparedQuestion[] = [];
  for (const candidate of input.candidates) {
    const stateCandidate = evaluationCandidate(input.source, candidate);
    for (const [ruleId, rule] of Object.entries(input.config.rules)) {
      if (rule.scope !== candidate.kind) continue;

      const evidenceResult = buildRuleEvidence(
        ruleId,
        candidate,
        input.projectFiles,
        input.changes,
      );
      let compacted: CompactedEvidence | undefined;
      if (evidenceResult.handled) {
        if (evidenceResult.evidence === undefined) continue;
        compacted = compactEvidence(evidenceResult.evidence);
      }
      const question: PreparedQuestion = {
        candidate,
        evaluationCandidate: stateCandidate,
        ruleId,
        rule,
      };
      if (compacted !== undefined) question.evidence = compacted.evidence;
      if (compacted?.moduleSource !== undefined) {
        question.moduleSource = compacted.moduleSource;
      }
      prepared.push(question);
    }
  }
  return prepared;
}

function buildRequest(filePath: string, prepared: PreparedQuestion[]): BuiltRequest {
  const candidates: EvaluationCandidate[] = [];
  const candidateIndexes = new Map<string, number>();
  const questions: EvaluationRequest["questions"] = {};
  const pending: PendingQuestion[] = [];

  for (const item of prepared) {
    let candidateIndex = candidateIndexes.get(item.candidate.id);
    if (candidateIndex === undefined) {
      candidateIndex = candidates.length;
      candidateIndexes.set(item.candidate.id, candidateIndex);
      candidates.push({ ...item.evaluationCandidate });
    }
    const stateCandidate = candidates[candidateIndex];
    if (!stateCandidate) continue;
    let evidencePath: string | undefined;
    if (item.evidence !== undefined) {
      stateCandidate.evidence ??= {};
      stateCandidate.evidence[item.ruleId] = item.evidence;
      evidencePath = `candidates[${candidateIndex}].evidence["${item.ruleId}"]`;
    }

    const questionId = `q${pending.length}`;
    const candidatePath = `candidates[${candidateIndex}]`;
    const instructions: QuestionInstructions = {
      schema: EVALUATION_SCHEMA,
      ruleId: item.ruleId,
      question: item.rule.question.instructions,
      inspect: candidatePath,
      context: stateCandidate.nearbySource === undefined
        ? `${candidatePath}.source`
        : `${candidatePath}.nearbySource`,
      evidence: evidencePath ?? null,
    };
    const question: NoulQuestion = { type: "noul", instructions };
    if (item.rule.question.criteria !== undefined) question.criteria = item.rule.question.criteria;
    questions[questionId] = question;
    pending.push({ id: questionId, prepared: item });
  }

  const moduleSource = prepared.find((item) => item.moduleSource !== undefined)?.moduleSource;
  const file: EvaluationRequest["state"]["file"] = { path: filePath };
  if (moduleSource !== undefined) file.source = moduleSource;
  return {
    request: {
      state: { file, candidates },
      questions,
    },
    pending,
  };
}

function requestSize(filePath: string, prepared: PreparedQuestion[]): number {
  return JSON.stringify(buildRequest(filePath, prepared).request).length;
}

function batches(filePath: string, prepared: PreparedQuestion[]): PreparedQuestion[][] {
  const result: PreparedQuestion[][] = [];
  let current: PreparedQuestion[] = [];
  for (const item of prepared) {
    const next = [...current, item];
    if (
      current.length > 0
      && (
        next.length > MAX_QUESTIONS_PER_REQUEST
        || requestSize(filePath, next) > EVALUATION_REQUEST_BUDGET_CHARS
      )
    ) {
      result.push(current);
      current = [item];
    } else {
      current = next;
    }
  }
  if (current.length > 0) result.push(current);
  return result;
}

function errorMessage(error: Error): string {
  return error.message.replaceAll(/\s+/g, " ").trim().slice(0, FAILURE_MESSAGE_LIMIT);
}

function isTokenLimitError(error: Error): boolean {
  return /max[_ -]?tokens|token limit|context length/i.test(errorMessage(error));
}

function evaluationFailure(
  filePath: string,
  prepared: PreparedQuestion[],
  message: string,
): EvaluationFailure {
  return {
    filePath,
    candidateIds: [...new Set(prepared.map((item) => item.candidate.id))],
    ruleIds: [...new Set(prepared.map((item) => item.ruleId))],
    questionCount: prepared.length,
    message,
  };
}

function diagnostic(item: PreparedQuestion, probability: number): Diagnostic | undefined {
  if (probability < item.rule.threshold) return undefined;
  return {
    filePath: item.candidate.filePath,
    line: item.candidate.startLine,
    column: item.candidate.startColumn,
    endLine: item.candidate.endLine,
    endColumn: item.candidate.endColumn,
    severity: item.rule.severity,
    ruleId: item.ruleId,
    message: item.rule.message,
    probability,
  };
}

async function evaluateBatch(
  filePath: string,
  prepared: PreparedQuestion[],
  evaluator: Evaluator,
  result: AnalysisResult,
): Promise<void> {
  const { request, pending } = buildRequest(filePath, prepared);
  let answers: Record<string, number>;
  try {
    answers = await evaluator.evaluate(request);
  } catch (cause) {
    const error = cause instanceof Error ? cause : new Error(String(cause));
    if (isTokenLimitError(error) && prepared.length > 1) {
      const middle = Math.floor(prepared.length / 2);
      await evaluateBatch(filePath, prepared.slice(0, middle), evaluator, result);
      await evaluateBatch(filePath, prepared.slice(middle), evaluator, result);
      return;
    }
    result.failures.push(evaluationFailure(filePath, prepared, errorMessage(error)));
    return;
  }

  const unanswered: PreparedQuestion[] = [];
  for (const { id, prepared: item } of pending) {
    const probability = answers[id];
    if (probability === undefined) {
      unanswered.push(item);
      continue;
    }
    const finding = diagnostic(item, probability);
    if (finding) result.diagnostics.push(finding);
  }
  if (unanswered.length > 0) {
    result.failures.push(evaluationFailure(
      filePath,
      unanswered,
      `Evaluator omitted ${unanswered.length} answer${unanswered.length === 1 ? "" : "s"}.`,
    ));
  }
}

async function analyzeCandidates(
  input: AnalyzeCandidatesInput,
  evaluator: Evaluator,
): Promise<AnalysisResult> {
  const prepared = prepareQuestions(input);
  const result: AnalysisResult = { diagnostics: [], failures: [] };
  for (const batch of batches(input.filePath, prepared)) {
    await evaluateBatch(input.filePath, batch, evaluator, result);
  }
  result.diagnostics = deduplicateDiagnostics(result.diagnostics);
  return result;
}

export async function analyzeFileWithFailures(
  input: AnalyzeFileInput,
  evaluator: Evaluator,
): Promise<AnalysisResult> {
  const candidates = filterCandidatesByChangedLines(
    extractCandidates(input.filePath, input.source),
    input.changedLines,
  ).filter((candidate) =>
    Object.values(input.config.rules).some((rule) => rule.scope === candidate.kind),
  );
  const projectFiles = input.projectFiles ?? [
    { filePath: input.filePath, source: input.source },
  ];
  return analyzeCandidates({
    filePath: input.filePath,
    source: input.source,
    candidates,
    config: input.config,
    projectFiles,
    changes: [],
  }, evaluator);
}

function throwEvaluationFailures(failures: EvaluationFailure[]): void {
  if (failures.length === 0) return;
  const questions = failures.reduce((total, failure) => total + failure.questionCount, 0);
  throw new Error(
    `${questions} evaluation question${questions === 1 ? "" : "s"} failed: ${failures[0]?.message ?? "unknown error"}`,
  );
}

export async function analyzeFile(
  input: AnalyzeFileInput,
  evaluator: Evaluator,
): Promise<Diagnostic[]> {
  const result = await analyzeFileWithFailures(input, evaluator);
  throwEvaluationFailures(result.failures);
  return result.diagnostics;
}

function changeCandidate(change: SourceFile, totalFiles: number): Candidate {
  const startLine = Math.min(...change.changedLines.map(({ start }) => start));
  const endLine = Math.max(...change.changedLines.map(({ end }) => end));
  return {
    id: "change_0",
    kind: "change",
    filePath: change.filePath,
    source: `Whole change across ${totalFiles} file${totalFiles === 1 ? "" : "s"}. Use the rule-specific before/after evidence and its coverage metadata.`,
    start: 0,
    end: change.source.length,
    startLine,
    startColumn: 1,
    endLine,
    endColumn: 1,
  };
}

export async function analyzeChangesWithFailures(
  input: AnalyzeChangesInput,
  evaluator: Evaluator,
): Promise<AnalysisResult> {
  if (!Object.values(input.config.rules).some(({ scope }) => scope === "change")) {
    return { diagnostics: [], failures: [] };
  }
  const anchor = input.changes.find(({ oldSource }) => oldSource !== null) ?? input.changes[0];
  if (!anchor || anchor.changedLines.length === 0) return { diagnostics: [], failures: [] };
  return analyzeCandidates({
    filePath: anchor.filePath,
    source: anchor.source,
    candidates: [changeCandidate(anchor, input.changes.length)],
    config: input.config,
    projectFiles: input.projectFiles,
    changes: input.changes,
  }, evaluator);
}

export async function analyzeChanges(
  input: AnalyzeChangesInput,
  evaluator: Evaluator,
): Promise<Diagnostic[]> {
  const result = await analyzeChangesWithFailures(input, evaluator);
  throwEvaluationFailures(result.failures);
  return result.diagnostics;
}
