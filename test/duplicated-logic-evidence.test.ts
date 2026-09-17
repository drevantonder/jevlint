import { describe, expect, it } from "vitest";
import { extractCandidates } from "../src/candidates.js";
import { buildDuplicatedLogicEvidence } from "../src/evidence/duplicated-logic.js";
import type { ProjectFile } from "../src/types.js";

const invoiceSource = `export interface Item {
  name: string;
  price: number;
}

export function formatInvoice(items: Item[]): string {
  const lines: string[] = [];
  for (const item of items) {
    lines.push(item.name + ": $" + item.price);
  }
  lines.push("TOTAL");
  return lines.join("\\n");
}
`;

const receiptSource = `import type { Item } from "./invoice.js";

export function formatReceipt(items: Item[]): string {
  const lines: string[] = [];
  for (const item of items) {
    lines.push(item.name + ": $" + item.price);
  }
  lines.push("TOTAL");
  return lines.join("\\n");
}
`;

const checkoutSource = `import { formatInvoice } from "./invoice.js";
import { formatReceipt } from "./receipt.js";

export function checkout(items: Item[]): string {
  return formatInvoice(items) + formatReceipt(items);
}
`;

function candidate(source: string, filePath: string) {
  return extractCandidates(filePath, source).find(({ kind }) => kind === "function");
}

describe("duplicated logic evidence", () => {
  it("matches a reimplemented body through shared literals and members", () => {
    const files: ProjectFile[] = [
      { filePath: "src/invoice.ts", source: invoiceSource },
      { filePath: "src/receipt.ts", source: receiptSource },
      { filePath: "src/checkout.ts", source: checkoutSource },
    ];
    const fn = candidate(invoiceSource, "src/invoice.ts");
    expect(fn).toBeDefined();
    if (!fn) return;

    const evidence = buildDuplicatedLogicEvidence(fn, files);

    expect(evidence).toMatchObject({
      function: { name: "formatInvoice", filePath: "src/invoice.ts" },
      matches: [expect.objectContaining({
        filePath: "src/receipt.ts",
        functionName: "formatReceipt",
      })],
    });
    const match = evidence?.matches[0];
    expect(match?.sharedLiteralValues).toContain("TOTAL");
    expect(match?.sharedMemberNames).toEqual(
      expect.arrayContaining(["join", "name", "price"]),
    );
    expect(match?.sharedMemberNames).not.toContain("push");
    expect(evidence?.callers).toEqual([
      expect.objectContaining({ filePath: "src/checkout.ts", call: expect.stringContaining("formatInvoice") }),
    ]);
  });

  it("abstains when no other function shares domain tokens", () => {
    const source = `export function total(prices: number[]): number {
      let sum = 0;
      for (const price of prices) {
        sum += price;
      }
      return sum;
    }
    `;
    const fn = candidate(source, "src/total.ts");
    expect(fn).toBeDefined();
    if (!fn) return;

    expect(buildDuplicatedLogicEvidence(fn, [{ filePath: "src/total.ts", source }])).toBeUndefined();
  });
});
