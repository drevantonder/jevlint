import type { JsonValue, NoulQuestion } from "@typesafe-ai/sdk";
import { extractCandidates, filterCandidatesByChangedLines } from "./candidates.js";
import { deduplicateDiagnostics } from "./deduplicate.js";
import { buildRuleEvidence } from "./evidence/index.js";
import type {
  Candidate,
  Diagnostic,
  EvaluationCandidate,
  EvaluationRequest,
  Evaluator,
  JevLintConfig,
  LineRange,
  ProjectFile,
  RuleConfig,
  SourceFile,
} from "./types.js";

interface AnalyzeFileInput {
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

interface PendingQuestion {
  candidate: Candidate;
  ruleId: string;
  rule: RuleConfig;
}

interface AnalyzeCandidatesInput {
  filePath: string;
  source: string;
  candidates: Candidate[];
  config: JevLintConfig;
  projectFiles: ProjectFile[];
  changes: SourceFile[];
}

const EVALUATION_SCHEMA = "jevlint-semantic-judgment-v1";

interface QuestionInstructions {
  [key: string]: JsonValue;
  schema: typeof EVALUATION_SCHEMA;
  ruleId: string;
  question: RuleConfig["question"]["instructions"];
  inspect: string;
  context: string;
  evidence: string | null;
}

function normalizeSource(source: string): string {
  return source.replaceAll("\r\n", "\n").replaceAll("\r", "\n");
}

function nearbySource(source: string, candidate: Candidate): string {
  if (candidate.kind === "function" || candidate.kind === "change") return candidate.source;
  const lines = source.split("\n");
  const start = Math.max(0, candidate.startLine - 2);
  const end = Math.min(lines.length, candidate.endLine + 3);
  return lines.slice(start, end).join("\n");
}

function evaluationCandidate(source: string, candidate: Candidate): EvaluationCandidate {
  return {
    id: candidate.id,
    kind: candidate.kind,
    source: normalizeSource(candidate.source),
    nearbySource: normalizeSource(nearbySource(source, candidate)),
    startLine: candidate.startLine,
    endLine: candidate.endLine,
  };
}

async function analyzeCandidates(
  input: AnalyzeCandidatesInput,
  evaluator: Evaluator,
): Promise<Diagnostic[]> {
  if (input.candidates.length === 0) return [];
  const request: EvaluationRequest = {
    state: {
      file: { path: input.filePath },
      candidates: input.candidates.map((candidate) => evaluationCandidate(input.source, candidate)),
    },
    questions: {},
  };
  const pending = new Map<string, PendingQuestion>();

  for (const [candidateIndex, candidate] of input.candidates.entries()) {
    for (const [ruleId, rule] of Object.entries(input.config.rules)) {
      if (rule.scope !== candidate.kind) continue;

      let evidencePath: string | undefined;
      const evidenceResult = buildRuleEvidence(
        ruleId,
        candidate,
        input.projectFiles,
        input.changes,
      );
      if (evidenceResult.handled) {
        if (evidenceResult.evidence === undefined) continue;
        const stateCandidate = request.state.candidates[candidateIndex];
        if (!stateCandidate) continue;
        stateCandidate.evidence ??= {};
        stateCandidate.evidence[ruleId] = evidenceResult.evidence;
        evidencePath = `candidates[${candidateIndex}].evidence["${ruleId}"]`;
      }

      const questionId = `q${pending.size}`;
      const instructions: QuestionInstructions = {
        schema: EVALUATION_SCHEMA,
        ruleId,
        question: rule.question.instructions,
        inspect: `candidates[${candidateIndex}]`,
        context: `candidates[${candidateIndex}].nearbySource`,
        evidence: evidencePath ?? null,
      };
      const question: NoulQuestion = { type: "noul", instructions };
      if (rule.question.criteria !== undefined) question.criteria = rule.question.criteria;
      request.questions[questionId] = question;
      pending.set(questionId, { candidate, ruleId, rule });
    }
  }

  if (pending.size === 0) return [];
  const answers = await evaluator.evaluate(request);
  const diagnostics: Diagnostic[] = [];
  for (const [questionId, item] of pending) {
    const probability = answers[questionId];
    if (probability === undefined) {
      throw new Error(`Evaluator did not return an answer for ${questionId}.`);
    }
    if (probability < item.rule.threshold) continue;

    diagnostics.push({
      filePath: item.candidate.filePath,
      line: item.candidate.startLine,
      column: item.candidate.startColumn,
      endLine: item.candidate.endLine,
      endColumn: item.candidate.endColumn,
      severity: item.rule.severity,
      ruleId: item.ruleId,
      message: item.rule.message,
      probability,
    });
  }

  return deduplicateDiagnostics(diagnostics);
}

export async function analyzeFile(
  input: AnalyzeFileInput,
  evaluator: Evaluator,
): Promise<Diagnostic[]> {
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

function changeCandidate(change: SourceFile): Candidate {
  const startLine = Math.min(...change.changedLines.map(({ start }) => start));
  const endLine = Math.max(...change.changedLines.map(({ end }) => end));
  return {
    id: "change_0",
    kind: "change",
    filePath: change.filePath,
    source: change.source,
    start: 0,
    end: change.source.length,
    startLine,
    startColumn: 1,
    endLine,
    endColumn: 1,
  };
}

export async function analyzeChanges(
  input: AnalyzeChangesInput,
  evaluator: Evaluator,
): Promise<Diagnostic[]> {
  if (!Object.values(input.config.rules).some(({ scope }) => scope === "change")) return [];
  const anchor = input.changes.find(({ oldSource }) => oldSource !== null) ?? input.changes[0];
  if (!anchor || anchor.changedLines.length === 0) return [];
  return analyzeCandidates({
    filePath: anchor.filePath,
    source: anchor.source,
    candidates: [changeCandidate(anchor)],
    config: input.config,
    projectFiles: input.projectFiles,
    changes: input.changes,
  }, evaluator);
}
