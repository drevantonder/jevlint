import { createHash, randomUUID } from "node:crypto";
import { mkdir, readFile, rename, unlink, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import type { JsonValue, NoulQuestion } from "@typesafe-ai/sdk";
import { z } from "zod";
import type { EvaluationRequest, EvaluationState, Evaluator } from "./types.js";

const CACHE_FORMAT = "jevlint-semantic-response-v1";

export type CacheMode = "read-write" | "refresh" | "disabled";

export interface EvaluatorIdentity {
  provider: string;
  endpoint: string;
  model: string;
  sdk: string;
  evaluator: string;
}

export interface CacheStatistics {
  hits: number;
  misses: number;
  writes: number;
  recoveries: number;
  errors: number;
  liveRequests: number;
}

export interface CachedEvaluatorOptions {
  directory: string;
  repository: string;
  identity: EvaluatorIdentity;
  mode?: CacheMode;
}

interface CacheEntry {
  format: typeof CACHE_FORMAT;
  digest: string;
  probability: number;
}

const cacheEntrySchema = z.object({
  format: z.literal(CACHE_FORMAT),
  digest: z.string().regex(/^[a-f\d]{64}$/),
  probability: z.number().min(0).max(1),
}).strict();

interface QuestionEntry {
  id: string;
  question: NoulQuestion;
  digest: string;
  path: string;
}

function canonicalJson(value: JsonValue): string {
  if (value === null) return "null";
  const stringValue = z.string().safeParse(value);
  if (stringValue.success) return JSON.stringify(stringValue.data);
  const numberValue = z.number().safeParse(value);
  if (numberValue.success) return JSON.stringify(numberValue.data);
  const booleanValue = z.boolean().safeParse(value);
  if (booleanValue.success) return JSON.stringify(booleanValue.data);
  if (Array.isArray(value)) return `[${value.map((item) => canonicalJson(item)).join(",")}]`;
  const objectValue = z.record(z.string(), z.json()).parse(value);
  return `{${Object.keys(objectValue).sort().map((key) =>
    `${JSON.stringify(key)}:${canonicalJson(objectValue[key] ?? null)}`
  ).join(",")}}`;
}

function evaluationState(state: EvaluationState): JsonValue {
  return {
    file: { path: state.file.path },
    candidates: state.candidates.map((candidate) => ({
      id: candidate.id,
      kind: candidate.kind,
      source: candidate.source,
      nearbySource: candidate.nearbySource,
      startLine: candidate.startLine,
      endLine: candidate.endLine,
      evidence: candidate.evidence ?? null,
    })),
  };
}

function evaluationCriteria(
  criteria: Exclude<NoulQuestion["criteria"], null | undefined>,
): JsonValue {
  if (criteria.true === undefined) {
    return criteria.false === undefined ? {} : { false: criteria.false };
  }
  return criteria.false === undefined
    ? { true: criteria.true }
    : { true: criteria.true, false: criteria.false };
}

function evaluationQuestion(question: NoulQuestion): JsonValue {
  let criteria: JsonValue | undefined;
  if (question.criteria === null) criteria = null;
  else if (question.criteria !== undefined) criteria = evaluationCriteria(question.criteria);

  if (question.instructions === undefined) {
    return criteria === undefined ? { type: question.type } : { type: question.type, criteria };
  }
  return criteria === undefined
    ? { type: question.type, instructions: question.instructions }
    : { type: question.type, instructions: question.instructions, criteria };
}

function digestQuestion(
  repository: string,
  identity: EvaluatorIdentity,
  state: EvaluationRequest["state"],
  question: NoulQuestion,
): string {
  const material: JsonValue = {
    format: CACHE_FORMAT,
    repository,
    identity: {
      provider: identity.provider,
      endpoint: identity.endpoint,
      model: identity.model,
      sdk: identity.sdk,
      evaluator: identity.evaluator,
    },
    state: evaluationState(state),
    question: evaluationQuestion(question),
  };
  return createHash("sha256").update(canonicalJson(material)).digest("hex");
}

function cachePath(directory: string, digest: string): string {
  return join(directory, digest.slice(0, 2), `${digest.slice(2)}.json`);
}

function parseEntry(text: string, digest: string): CacheEntry | undefined {
  try {
    const parsed = cacheEntrySchema.safeParse(JSON.parse(text));
    if (!parsed.success || parsed.data.digest !== digest) return undefined;
    return parsed.data;
  } catch {
    return undefined;
  }
}

async function writeAtomically(path: string, entry: CacheEntry): Promise<void> {
  await mkdir(dirname(path), { recursive: true, mode: 0o700 });
  const temporaryPath = `${path}.${process.pid}.${randomUUID()}.tmp`;
  try {
    await writeFile(temporaryPath, `${JSON.stringify(entry)}\n`, {
      encoding: "utf8",
      flag: "wx",
      mode: 0o600,
    });
    await rename(temporaryPath, path);
  } finally {
    await unlink(temporaryPath).catch(() => undefined);
  }
}

export class CachedEvaluator implements Evaluator {
  readonly statistics: CacheStatistics = {
    hits: 0,
    misses: 0,
    writes: 0,
    recoveries: 0,
    errors: 0,
    liveRequests: 0,
  };

  private readonly inFlight = new Map<string, Promise<number>>();
  private readonly mode: CacheMode;

  constructor(
    private readonly delegate: Evaluator,
    private readonly options: CachedEvaluatorOptions,
  ) {
    this.mode = options.mode ?? "read-write";
  }

  async evaluate(request: EvaluationRequest): Promise<Record<string, number>> {
    if (this.mode === "disabled") return this.delegate.evaluate(request);

    const entries = Object.entries(request.questions).map(([id, question]): QuestionEntry => {
      const digest = digestQuestion(
        this.options.repository,
        this.options.identity,
        request.state,
        question,
      );
      return { id, question, digest, path: cachePath(this.options.directory, digest) };
    });
    const answers: Record<string, number> = {};
    const missing: QuestionEntry[] = [];

    for (const entry of entries) {
      if (this.mode === "refresh") {
        this.statistics.misses += 1;
        missing.push(entry);
        continue;
      }
      try {
        const text = await readFile(entry.path, "utf8");
        const cached = parseEntry(text, entry.digest);
        if (cached) {
          answers[entry.id] = cached.probability;
          this.statistics.hits += 1;
          continue;
        }
        this.statistics.recoveries += 1;
      } catch (error) {
        const code = error instanceof Error && "code" in error ? error.code : undefined;
        if (code !== "ENOENT") this.statistics.errors += 1;
      }
      this.statistics.misses += 1;
      missing.push(entry);
    }

    const ownedDigests = new Set<string>();
    const owned = missing.filter((entry) => {
      if (this.inFlight.has(entry.digest) || ownedDigests.has(entry.digest)) return false;
      ownedDigests.add(entry.digest);
      return true;
    });
    if (owned.length > 0) {
      const questions = Object.fromEntries(owned.map(({ id, question }) => [id, question]));
      this.statistics.liveRequests += 1;
      const evaluated = this.delegate.evaluate({ state: request.state, questions });
      for (const entry of owned) {
        const probability = evaluated.then(async (result) => {
          const answer = result[entry.id];
          if (answer === undefined) {
            throw new Error(`Evaluator did not return an answer for ${entry.id}.`);
          }
          if (!Number.isFinite(answer) || answer < 0 || answer > 1) {
            throw new Error(`Evaluator returned an invalid probability for ${entry.id}.`);
          }
          try {
            await writeAtomically(entry.path, {
              format: CACHE_FORMAT,
              digest: entry.digest,
              probability: answer,
            });
            this.statistics.writes += 1;
          } catch {
            this.statistics.errors += 1;
          }
          return answer;
        });
        this.inFlight.set(entry.digest, probability);
        void probability.finally(() => {
          if (this.inFlight.get(entry.digest) === probability) this.inFlight.delete(entry.digest);
        }).catch(() => undefined);
      }
    }

    await Promise.all(missing.map(async (entry) => {
      const probability = await this.inFlight.get(entry.digest);
      if (probability === undefined) throw new Error(`Missing evaluation for ${entry.id}.`);
      answers[entry.id] = probability;
    }));
    return answers;
  }
}
