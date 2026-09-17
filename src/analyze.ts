import type { JsonValue, NoulQuestion } from "@typesafe-ai/sdk";
import {
  countImporterInDegree,
  extractCandidates,
  extractModuleCandidates,
  filterCandidatesByChangedLines,
  planWholeRepoModuleCandidates,
} from "./candidates.js";
import { buildRuleEvidence } from "./evidence/index.js";
import { buildModuleGraph } from "./evidence/module.js";
import type {
  AnalysisResult,
  AuditCoverage,
  Candidate,
  CandidateKind,
  EvaluationCandidate,
  EvaluationFailure,
  EvaluationRequest,
  Evaluator,
  JevLintConfig,
  Judgment,
  LineRange,
  OmittedByKind,
  OmittedByRule,
  ProjectFile,
  RuleConfig,
  SourceFile,
  StructuralAbstentionCount,
  UnscoredRule,
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

interface PreparedAnalysis {
  questions: PreparedQuestion[];
  abstentions: StructuralAbstentionCount[];
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

function abstentionKey(ruleId: string, candidateKind: CandidateKind): string {
  return `${ruleId}\u0000${candidateKind}`;
}

export function sortAbstentions(
  abstentions: StructuralAbstentionCount[],
): StructuralAbstentionCount[] {
  const counts = new Map<string, StructuralAbstentionCount>();
  for (const abstention of abstentions) {
    const key = abstentionKey(abstention.ruleId, abstention.candidateKind);
    const existing = counts.get(key);
    if (existing) existing.count += abstention.count;
    else counts.set(key, { ...abstention });
  }
  return [...counts.values()].sort((left, right) =>
    left.ruleId.localeCompare(right.ruleId)
    || left.candidateKind.localeCompare(right.candidateKind)
  );
}

function prepareQuestions(input: AnalyzeCandidatesInput): PreparedAnalysis {
  const questions: PreparedQuestion[] = [];
  const abstentions: StructuralAbstentionCount[] = [];
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
        if (evidenceResult.evidence === undefined) {
          abstentions.push({ ruleId, candidateKind: candidate.kind, count: 1 });
          continue;
        }
        compacted = compactEvidence(evidenceResult.evidence);
      }
      const question: PreparedQuestion = {
        candidate,
        evaluationCandidate: stateCandidate,
        ruleId,
        rule,
      };
      if (compacted !== undefined) question.evidence = compacted.evidence;
      if (compacted?.moduleSource !== undefined) question.moduleSource = compacted.moduleSource;
      questions.push(question);
    }
  }
  return { questions, abstentions: sortAbstentions(abstentions) };
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

function judgment(item: PreparedQuestion, probability: number): Judgment {
  return {
    ruleId: item.ruleId,
    message: item.rule.message,
    probability,
    filePath: item.candidate.filePath,
    span: {
      start: { line: item.candidate.startLine, column: item.candidate.startColumn },
      end: { line: item.candidate.endLine, column: item.candidate.endColumn },
    },
    candidateKind: item.candidate.kind,
    evidence: item.evidence ?? null,
  };
}

export function sortJudgments(judgments: Judgment[]): Judgment[] {
  return [...judgments].sort((left, right) =>
    right.probability - left.probability
    || left.filePath.localeCompare(right.filePath)
    || left.span.start.line - right.span.start.line
    || left.span.start.column - right.span.start.column
    || left.span.end.line - right.span.end.line
    || left.span.end.column - right.span.end.column
    || left.ruleId.localeCompare(right.ruleId)
    || left.candidateKind.localeCompare(right.candidateKind)
  );
}

async function evaluateBatch(
  filePath: string,
  prepared: PreparedQuestion[],
  evaluator: Evaluator,
  result: AnalysisResult,
): Promise<void> {
  const { request, pending } = buildRequest(filePath, prepared);
  result.statistics.requests += 1;
  result.statistics.questions += pending.length;
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
  const invalid: PreparedQuestion[] = [];
  for (const { id, prepared: item } of pending) {
    const probability = answers[id];
    if (probability === undefined) {
      unanswered.push(item);
      continue;
    }
    if (!Number.isFinite(probability) || probability < 0 || probability > 1) {
      invalid.push(item);
      continue;
    }
    result.judgments.push(judgment(item, probability));
  }
  if (unanswered.length > 0) {
    result.failures.push(evaluationFailure(
      filePath,
      unanswered,
      `Evaluator omitted ${unanswered.length} answer${unanswered.length === 1 ? "" : "s"}.`,
    ));
  }
  if (invalid.length > 0) {
    result.failures.push(evaluationFailure(
      filePath,
      invalid,
      `Evaluator returned ${invalid.length} invalid probabilit${invalid.length === 1 ? "y" : "ies"}.`,
    ));
  }
}

async function analyzeCandidates(
  input: AnalyzeCandidatesInput,
  evaluator: Evaluator,
): Promise<AnalysisResult> {
  const prepared = prepareQuestions(input);
  const result: AnalysisResult = {
    judgments: [],
    abstentions: prepared.abstentions,
    failures: [],
    statistics: { requests: 0, questions: 0 },
  };
  for (const batch of batches(input.filePath, prepared.questions)) {
    await evaluateBatch(input.filePath, batch, evaluator, result);
  }
  result.judgments = sortJudgments(result.judgments);
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
): Promise<Judgment[]> {
  const result = await analyzeFileWithFailures(input, evaluator);
  throwEvaluationFailures(result.failures);
  return result.judgments;
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

function emptyAnalysis(): AnalysisResult {
  return {
    judgments: [],
    abstentions: [],
    failures: [],
    statistics: { requests: 0, questions: 0 },
  };
}

export async function analyzeChangesWithFailures(
  input: AnalyzeChangesInput,
  evaluator: Evaluator,
): Promise<AnalysisResult> {
  if (!Object.values(input.config.rules).some(({ scope }) => scope === "change")) {
    return emptyAnalysis();
  }
  const anchor = input.changes.find(({ oldSource }) => oldSource !== null) ?? input.changes[0];
  if (!anchor || anchor.changedLines.length === 0) return emptyAnalysis();
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
): Promise<Judgment[]> {
  const result = await analyzeChangesWithFailures(input, evaluator);
  throwEvaluationFailures(result.failures);
  return result.judgments;
}

export async function analyzeModulesWithFailures(
  input: AnalyzeChangesInput,
  evaluator: Evaluator,
): Promise<AnalysisResult> {
  if (!Object.values(input.config.rules).some(({ scope }) => scope === "module")) {
    return emptyAnalysis();
  }
  const candidates = extractModuleCandidates(input.changes, input.projectFiles);
  if (candidates.length === 0) return emptyAnalysis();
  const anchor = candidates[0];
  if (!anchor) return emptyAnalysis();
  return analyzeCandidates({
    filePath: anchor.filePath,
    source: "",
    candidates,
    config: input.config,
    projectFiles: input.projectFiles,
    changes: input.changes,
  }, evaluator);
}

export async function analyzeModules(
  input: AnalyzeChangesInput,
  evaluator: Evaluator,
): Promise<Judgment[]> {
  const result = await analyzeModulesWithFailures(input, evaluator);
  throwEvaluationFailures(result.failures);
  return result.judgments;
}

export const AUDIT_UNSCORED_REASON = "requires-before-after-change-context";

const AUDIT_KIND_ORDER: CandidateKind[] = ["module", "abstraction", "function", "comment"];

export interface AnalyzeAuditInput {
  projectFiles: ProjectFile[];
  config: JevLintConfig;
  maxQuestions?: number;
  evidenceBudgetMs?: number;
  dryRun?: boolean;
}

export interface AnalyzeAuditResult extends AnalysisResult {
  coverage: AuditCoverage;
}

interface OrderedAuditCandidate {
  candidate: Candidate;
  source: string;
}

function hasTruncatedFlag(value: JsonValue): boolean {
  return JSON.stringify(value).includes('"truncated":true');
}

function orderAuditCandidates(
  projectFiles: ProjectFile[],
  config: JevLintConfig,
): OrderedAuditCandidate[] {
  const graph = buildModuleGraph(projectFiles);
  const inDegree = countImporterInDegree(projectFiles, graph);
  const sourcesByPath = new Map(projectFiles.map((file) => [file.filePath, file.source]));
  const ordered: OrderedAuditCandidate[] = [];

  for (const candidate of planWholeRepoModuleCandidates(projectFiles, graph)) {
    if (!Object.values(config.rules).some((rule) => rule.scope === candidate.kind)) continue;
    ordered.push({
      candidate: { ...candidate, id: `audit:${candidate.filePath}#${candidate.id}` },
      source: "",
    });
  }

  const byKind = new Map<CandidateKind, OrderedAuditCandidate[]>();
  for (const file of projectFiles) {
    for (const candidate of extractCandidates(file.filePath, file.source)) {
      if (!Object.values(config.rules).some((rule) => rule.scope === candidate.kind)) continue;
      const list = byKind.get(candidate.kind) ?? [];
      list.push({
        candidate: { ...candidate, id: `audit:${candidate.filePath}#${candidate.id}` },
        source: sourcesByPath.get(candidate.filePath) ?? file.source,
      });
      byKind.set(candidate.kind, list);
    }
  }
  for (const kind of ["abstraction", "function", "comment"] as const) {
    const list = byKind.get(kind) ?? [];
    list.sort((left, right) =>
      (inDegree.get(right.candidate.filePath) ?? 0) - (inDegree.get(left.candidate.filePath) ?? 0)
      || left.candidate.start - right.candidate.start
      || left.candidate.filePath.localeCompare(right.candidate.filePath)
    );
    ordered.push(...list);
  }
  return ordered;
}

export async function analyzeAuditWithFailures(
  input: AnalyzeAuditInput,
  evaluator: Evaluator,
): Promise<AnalyzeAuditResult> {
  const ordered = orderAuditCandidates(input.projectFiles, input.config);
  const rules = Object.entries(input.config.rules);
  const startedAt = Date.now();

  const prepared: { item: PreparedQuestion; source: string }[] = [];
  const abstentions: StructuralAbstentionCount[] = [];
  const visitedByRule = new Map<string, number>();
  const candidatesWithQuestions = new Set<string>();
  const filesWithQuestions = new Set<string>();
  let truncatedEvidence = 0;

  for (const entry of ordered) {
    for (const [ruleId, rule] of rules) {
      if (rule.scope !== entry.candidate.kind) continue;
      if (input.maxQuestions !== undefined && prepared.length >= input.maxQuestions) break;
      if (input.evidenceBudgetMs !== undefined && Date.now() - startedAt >= input.evidenceBudgetMs) {
        break;
      }
      visitedByRule.set(ruleId, (visitedByRule.get(ruleId) ?? 0) + 1);
      const evidenceResult = buildRuleEvidence(
        ruleId,
        entry.candidate,
        input.projectFiles,
        [],
      );
      if (evidenceResult.handled) {
        if (evidenceResult.evidence === undefined) {
          abstentions.push({ ruleId, candidateKind: entry.candidate.kind, count: 1 });
          continue;
        }
        const compacted = compactEvidence(evidenceResult.evidence);
        const question: PreparedQuestion = {
          candidate: entry.candidate,
          evaluationCandidate: evaluationCandidate(entry.source, entry.candidate),
          ruleId,
          rule,
          evidence: compacted.evidence,
        };
        if (compacted.moduleSource !== undefined) question.moduleSource = compacted.moduleSource;
        prepared.push({ item: question, source: entry.source });
        candidatesWithQuestions.add(entry.candidate.id);
        filesWithQuestions.add(entry.candidate.filePath);
        if (hasTruncatedFlag(compacted.evidence)) truncatedEvidence += 1;
      } else {
        const question: PreparedQuestion = {
          candidate: entry.candidate,
          evaluationCandidate: evaluationCandidate(entry.source, entry.candidate),
          ruleId,
          rule,
        };
        prepared.push({ item: question, source: entry.source });
        candidatesWithQuestions.add(entry.candidate.id);
        filesWithQuestions.add(entry.candidate.filePath);
      }
    }
    const capped = (input.maxQuestions !== undefined && prepared.length >= input.maxQuestions)
      || (input.evidenceBudgetMs !== undefined && Date.now() - startedAt >= input.evidenceBudgetMs);
    if (capped) break;
  }

  const candidatesByKind = new Map<CandidateKind, number>();
  for (const entry of ordered) {
    candidatesByKind.set(entry.candidate.kind, (candidatesByKind.get(entry.candidate.kind) ?? 0) + 1);
  }
  const omittedByRule: OmittedByRule[] = [];
  const omittedTotals = new Map<CandidateKind, number>();
  for (const [ruleId, rule] of rules) {
    if (rule.scope === "change") continue;
    const total = candidatesByKind.get(rule.scope) ?? 0;
    const omitted = total - (visitedByRule.get(ruleId) ?? 0);
    if (omitted > 0) {
      omittedByRule.push({ ruleId, omitted });
      omittedTotals.set(rule.scope, (omittedTotals.get(rule.scope) ?? 0) + omitted);
    }
  }
  omittedByRule.sort((left, right) => left.ruleId.localeCompare(right.ruleId));
  const omittedByKind: OmittedByKind[] = AUDIT_KIND_ORDER
    .filter((kind) => (omittedTotals.get(kind) ?? 0) > 0)
    .map((kind) => ({ kind, omitted: omittedTotals.get(kind) ?? 0 }));
  const unscoredRules: UnscoredRule[] = rules
    .filter(([, rule]) => rule.scope === "change")
    .map(([ruleId, rule]) => ({ ruleId, scope: rule.scope, reason: AUDIT_UNSCORED_REASON }))
    .sort((left, right) => left.ruleId.localeCompare(right.ruleId));

  const result: AnalysisResult = {
    judgments: [],
    abstentions: sortAbstentions(abstentions),
    failures: [],
    statistics: { requests: 0, questions: 0 },
  };
  if (!input.dryRun) {
    const groups = new Map<string, { filePath: string; source: string; items: PreparedQuestion[] }>();
    for (const { item, source } of prepared) {
      const key = item.candidate.kind === "module" ? "audit:modules" : `audit:file:${item.candidate.filePath}`;
      const group = groups.get(key) ?? {
        filePath: item.candidate.kind === "module" ? item.candidate.filePath : item.candidate.filePath,
        source,
        items: [],
      };
      group.items.push(item);
      groups.set(key, group);
    }
    for (const group of groups.values()) {
      for (const batch of batches(group.filePath, group.items)) {
        await evaluateBatch(group.filePath, batch, evaluator, result);
      }
    }
    result.judgments = sortJudgments(result.judgments);
  }

  const filesEnumerated = input.projectFiles.length;
  const filesScored = filesWithQuestions.size;
  const coverage: AuditCoverage = {
    filesEnumerated,
    filesScored,
    filesOmitted: filesEnumerated - filesScored,
    candidatesEnumerated: ordered.length,
    candidatesScored: candidatesWithQuestions.size,
    questionsPrepared: prepared.length,
    questionsAsked: result.statistics.questions,
    maxQuestions: input.maxQuestions ?? null,
    evidenceBudgetMs: input.evidenceBudgetMs ?? null,
    dryRun: input.dryRun ?? false,
    omittedByKind,
    omittedByRule,
    unscoredRules,
    truncatedEvidence,
    complete: omittedByRule.length === 0,
  };
  return { ...result, coverage };
}
