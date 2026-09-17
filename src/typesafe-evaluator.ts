import { TypeSafeClient } from "@typesafe-ai/sdk";
import type { EntryType, Questions } from "@typesafe-ai/sdk";
import type { EvaluationRequest, EvaluationState, Evaluator } from "./types.js";

function stateEntry(state: EvaluationState): EntryType {
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
  private client: TypeSafeClient | undefined;

  async evaluate(request: EvaluationRequest): Promise<Record<string, number>> {
    const client = (this.client ??= new TypeSafeClient());
    const response = await client.systemOne({
      state: stateEntry(request.state),
      questions: request.questions satisfies Questions,
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
