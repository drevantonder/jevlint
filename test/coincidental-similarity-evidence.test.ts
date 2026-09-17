import { describe, expect, it } from "vitest";
import { extractCandidates } from "../src/candidates.js";
import { buildCoincidentalSimilarityEvidence } from "../src/evidence/coincidental-similarity.js";
import type { ProjectFile } from "../src/types.js";

const invoiceSource = `export interface Order {
  subtotal: number;
  payment: { fee: number };
}

export function totalInvoice(order: Order): number {
  const tax = order.subtotal * 0.2;
  const fee = order.payment.fee;
  return tax + fee;
}
`;

const payoutSource = `export interface Shift {
  hours: number;
  contract: { rate: number };
}

export function totalPayout(shift: Shift): number {
  const bonus = shift.hours * 0.1;
  const rate = shift.contract.rate;
  return bonus + rate;
}
`;

function candidate(source: string, filePath: string, name: string) {
  const found = extractCandidates(filePath, source).find(
    ({ kind, source: span }) => kind === "function" && span.includes(name),
  );
  expect(found?.kind).toBe("function");
  return found;
}

describe("coincidental similarity evidence", () => {
  it("pairs a similarity trigger with divergence signals for the lookalike", () => {
    const files: ProjectFile[] = [
      { filePath: "src/billing/invoice.ts", source: invoiceSource },
      { filePath: "src/payroll/payout.ts", source: payoutSource },
    ];
    const fn = candidate(invoiceSource, "src/billing/invoice.ts", "totalInvoice");
    if (!fn) return;

    const evidence = buildCoincidentalSimilarityEvidence(fn, files);

    expect(evidence).toMatchObject({
      function: { name: "totalInvoice", filePath: "src/billing/invoice.ts" },
      trigger: {
        sameOpcodeSequence: true,
      },
      lookalikes: [
        expect.objectContaining({
          functionName: "totalPayout",
          candidateOnlyMembers: expect.arrayContaining(["subtotal", "payment", "fee"]),
          matchOnlyMembers: expect.arrayContaining(["hours", "contract", "rate"]),
          candidateOnlyLiterals: expect.arrayContaining(["0.2"]),
          matchOnlyLiterals: expect.arrayContaining(["0.1"]),
          distinctNameTokens: expect.arrayContaining(["invoice", "payout"]),
          sameModuleRole: false,
          commonCallerFiles: [],
        }),
      ],
    });
    expect(evidence?.trigger.opcodeOverlap).toBeGreaterThanOrEqual(3);
  });

  it("abstains when no other function triggers the similarity threshold", () => {
    const source = `export function greet(name: string): string {
      return "hello " + name;
    }
    `;
    const fn = candidate(source, "src/greet.ts", "greet");
    if (!fn) return;

    expect(
      buildCoincidentalSimilarityEvidence(fn, [{ filePath: "src/greet.ts", source }]),
    ).toBeUndefined();
  });
});
