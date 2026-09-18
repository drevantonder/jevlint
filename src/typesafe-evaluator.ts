import { TypeSafeClient, VERSION as TYPESAFE_SDK_VERSION } from "@typesafe-ai/sdk";
import type { EntryType, Questions } from "@typesafe-ai/sdk";
import { CredentialRejectedError, isAuthFailure } from "./auth.js";
import type { CredentialSource } from "./auth.js";
import type { EvaluatorIdentity } from "./cache.js";
import type { EvaluationRequest, EvaluationState, Evaluator } from "./types.js";

const TYPESAFE_ENDPOINT = "https://api.typesafe.ai";
const JEV_MODEL = "jev-1.13.0";
const EVALUATOR_VERSION = "jevlint-system-one-v1";

export interface TypeSafeEvaluatorOptions {
  apiKey: string;
  credentialSource?: CredentialSource;
}

export function evaluationStateEntry(state: EvaluationState): EntryType {
  const file = state.file.source === undefined
    ? { path: state.file.path }
    : { path: state.file.path, source: state.file.source };
  const candidates = state.candidates.map((candidate) => {
    const entry = {
      id: candidate.id,
      kind: candidate.kind,
      source: candidate.source,
      startLine: candidate.startLine,
      endLine: candidate.endLine,
      evidence: candidate.evidence ?? null,
    };
    return candidate.nearbySource === undefined
      ? entry
      : { ...entry, nearbySource: candidate.nearbySource };
  });
  return { file, candidates };
}

export class TypeSafeEvaluator implements Evaluator {
  readonly identity: EvaluatorIdentity;
  private client: TypeSafeClient | undefined;
  private readonly endpoint: string;
  private readonly model: string;
  private readonly apiKey: string;
  private readonly credentialSource: CredentialSource | undefined;

  constructor(options: TypeSafeEvaluatorOptions) {
    this.endpoint = process.env.TYPESAFE_BASE_URL?.trim() || TYPESAFE_ENDPOINT;
    this.model = JEV_MODEL;
    this.apiKey = options.apiKey;
    this.credentialSource = options.credentialSource;
    this.identity = {
      provider: "typesafe-ai/system-one",
      endpoint: this.endpoint,
      model: this.model,
      sdk: `@typesafe-ai/sdk@${TYPESAFE_SDK_VERSION}`,
      evaluator: EVALUATOR_VERSION,
    };
  }

  async evaluate(request: EvaluationRequest): Promise<Record<string, number>> {
    const client = (this.client ??= new TypeSafeClient({
      baseURL: this.endpoint,
      apiKey: this.apiKey,
      defaultModel: this.model,
    }));
    try {
      const response = await client.systemOne({
        state: evaluationStateEntry(request.state),
        questions: request.questions satisfies Questions,
        model: this.model,
      });
      return Object.fromEntries(
        Object.entries(response.answers).map(([id, answer]) => {
          if (answer.type !== "noul") {
            throw new Error(`Expected a Noul answer for ${id}, received ${answer.type}`);
          }
          return [id, answer.noul];
        }),
      );
    } catch (cause) {
      const error = cause instanceof Error ? cause : new Error(String(cause));
      if (isAuthFailure(error)) {
        throw new CredentialRejectedError(this.credentialSource ?? "unknown");
      }
      throw cause;
    }
  }
}
