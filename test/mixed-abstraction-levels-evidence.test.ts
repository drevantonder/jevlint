import { describe, expect, it } from "vitest";
import { extractCandidates } from "../src/candidates.js";
import { buildMixedAbstractionLevelsEvidence } from "../src/evidence/mixed-abstraction-levels.js";
import type { ProjectFile } from "../src/types.js";

const billingSource = `import { chargeCustomer } from "./payments.js";

export function settleInvoice(amounts: number[], customerId: string): number {
  let total = 0;
  for (let index = 0; index < amounts.length; index += 1) {
    total += amounts[index] ?? 0;
  }
  const receipt = chargeCustomer(customerId, total);
  let checksum = 0;
  for (let offset = 0; offset < receipt.length; offset += 1) {
    checksum ^= receipt.charCodeAt(offset);
  }
  return checksum;
}

export function parseReceipt(receipt: string): number {
  let checksum = 0;
  for (let offset = 0; offset < receipt.length; offset += 1) {
    checksum ^= receipt.charCodeAt(offset);
  }
  return checksum;
}
`;

const paymentsSource = `export function chargeCustomer(customerId: string, total: number): string {
  return customerId + ":" + total;
}
`;

const ledgerSource = `import { settleInvoice } from "./billing.js";

export function closeDay(amounts: number[]): number {
  return settleInvoice(amounts, "acme");
}
`;

function candidate(source: string, filePath: string) {
  return extractCandidates(filePath, source).find(({ kind }) => kind === "function");
}

describe("mixed abstraction levels evidence", () => {
  it("extracts interleaved mechanics and domain calls", () => {
    const files: ProjectFile[] = [
      { filePath: "src/billing.ts", source: billingSource },
      { filePath: "src/payments.ts", source: paymentsSource },
      { filePath: "src/ledger.ts", source: ledgerSource },
    ];
    const fn = candidate(billingSource, "src/billing.ts");
    expect(fn).toBeDefined();
    if (!fn) return;

    const evidence = buildMixedAbstractionLevelsEvidence(fn, files);

    expect(evidence).toMatchObject({
      function: { name: "settleInvoice", filePath: "src/billing.ts" },
      mechanical: expect.arrayContaining([
        expect.objectContaining({ kind: "counter-loop" }),
        expect.objectContaining({ kind: "bitwise-operation" }),
      ]),
      domain: [expect.objectContaining({ kind: "imported-collaborator" })],
      wrappingHelper: "parseReceipt",
      importedSources: ["./payments.js"],
      callers: [expect.objectContaining({ filePath: "src/ledger.ts" })],
    });
    expect(evidence && evidence.alternations).toBeGreaterThan(0);
  });

  it("abstains when the body stays at the domain level", () => {
    const source = `import { chargeCustomer } from "./payments.js";

    export function settle(total: number): string {
      return chargeCustomer("acme", total);
    }
    `;
    const fn = candidate(source, "src/settle.ts");
    expect(fn).toBeDefined();
    if (!fn) return;

    const files = [
      { filePath: "src/settle.ts", source },
      { filePath: "src/payments.ts", source: paymentsSource },
    ];
    expect(buildMixedAbstractionLevelsEvidence(fn, files)).toBeUndefined();
  });
});
