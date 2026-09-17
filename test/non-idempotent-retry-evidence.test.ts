import { describe, expect, it } from "vitest";
import { extractCandidates } from "../src/candidates.js";
import { buildRuleEvidence } from "../src/evidence/index.js";
import { buildNonIdempotentRetryEvidence } from "../src/evidence/non-idempotent-retry.js";
import type { Candidate, ProjectFile } from "../src/types.js";

const keyless = `export async function checkout(order: Order) {
  return withRetry(() => payments.charge(order), { attempts: 3 });
}
`;

const keyed = `export async function checkout(order: Order) {
  return withRetry(() => payments.charge({ ...order, idempotencyKey: order.id }), { attempts: 3 });
}
`;

const readRetry = `export async function lookup(id: string) {
  return withRetry(() => users.find(id), { attempts: 3 });
}
`;

const plain = `export async function checkout(order: Order) {
  return payments.charge(order);
}
`;

function candidateFor(source: string, filePath: string, snippet: string): Candidate {
  const found = extractCandidates(filePath, source)
    .find(({ kind, source: text }) => kind === "function" && text.includes(snippet));
  expect(found).toBeDefined();
  expect(found?.kind).toBe("function");
  if (!found) throw new Error("candidate missing");
  return found;
}

describe("non-idempotent retry evidence", () => {
  it("extracts the keyless retried charge", () => {
    const projectFiles: ProjectFile[] = [{ filePath: "src/checkout.ts", source: keyless }];
    const candidate = candidateFor(keyless, "src/checkout.ts", "function checkout");

    const evidence = buildNonIdempotentRetryEvidence(candidate, projectFiles);

    expect(evidence).toMatchObject({
      function: { name: "checkout", exported: true },
      retries: [{
        kind: "retry-call",
        mutatingSinks: [expect.stringContaining("charge")],
        idempotencySignals: [],
      }],
    });
  });

  it("surfaces idempotency keys so the judgment can score low", () => {
    const projectFiles: ProjectFile[] = [{ filePath: "src/checkout.ts", source: keyed }];
    const candidate = candidateFor(keyed, "src/checkout.ts", "function checkout");

    const evidence = buildNonIdempotentRetryEvidence(candidate, projectFiles);

    expect(evidence?.retries[0]?.mutatingSinks).toEqual([expect.stringContaining("charge")]);
    expect(evidence?.retries[0]?.idempotencySignals).toContain("idempotencyKey");
  });

  it("abstains when the retry only repeats reads", () => {
    const candidate = candidateFor(readRetry, "src/users.ts", "function lookup");

    expect(buildNonIdempotentRetryEvidence(candidate, [{ filePath: "src/users.ts", source: readRetry }]))
      .toBeUndefined();
  });

  it("abstains when there is no retry span", () => {
    const candidate = candidateFor(plain, "src/checkout.ts", "function checkout");

    expect(buildNonIdempotentRetryEvidence(candidate, [{ filePath: "src/checkout.ts", source: plain }]))
      .toBeUndefined();
  });

  it("abstains for non-function candidates", () => {
    const comment = { ...candidateFor(keyless, "src/checkout.ts", "function checkout"), kind: "comment" as const };
    expect(buildNonIdempotentRetryEvidence(comment, [{ filePath: "src/checkout.ts", source: keyless }]))
      .toBeUndefined();
  });

  it("dispatches through the rule registry", () => {
    const projectFiles: ProjectFile[] = [{ filePath: "src/checkout.ts", source: keyless }];
    const candidate = candidateFor(keyless, "src/checkout.ts", "function checkout");

    const result = buildRuleEvidence("jev/no-non-idempotent-retry", candidate, projectFiles);

    expect(result.handled).toBe(true);
    expect(result.handled && result.evidence).toBeDefined();
  });
});
