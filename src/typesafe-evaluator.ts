import { TypeSafeClient, VERSION as TYPESAFE_SDK_VERSION } from "@typesafe-ai/sdk";
import type { EntryType, Questions } from "@typesafe-ai/sdk";
import type { EvaluatorIdentity } from "./cache.js";
import type { EvaluationRequest, EvaluationState, Evaluator } from "./types.js";

const TYPESAFE_ENDPOINT = "https://api.typesafe.ai";
const JEV_MODEL = "jev-1.13.0";
const EVALUATOR_VERSION = "jevlint-system-one-v1";

export function evaluationStateEntry(state: EvaluationState): EntryType {
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

export class TypeSafeEvaluator implements Evaluator {
  readonly identity: EvaluatorIdentity;
  private client: TypeSafeClient | undefined;
  private readonly endpoint: string;
  private readonly model: string;

  constructor() {
    this.endpoint = process.env.TYPESAFE_BASE_URL?.trim() || TYPESAFE_ENDPOINT;
    this.model = JEV_MODEL;
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
      defaultModel: this.model,
    }));
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
  }
}
