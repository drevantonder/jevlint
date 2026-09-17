import { describe, expect, it } from "vitest";
import { extractCandidates } from "../src/candidates.js";
import { buildFloatingMoneyArithmeticEvidence } from "../src/evidence/floating-money-arithmetic.js";

function candidateFor(source: string, marker: string) {
  const candidate = extractCandidates("src/cart.ts", source)
    .find(({ source: text }) => text.includes(marker));
  expect(candidate).toBeDefined();
  if (!candidate) throw new Error("fixture candidate missing");
  return candidate;
}

const FLOAT_TOTAL = `export function cartTotal(items: { price: number; qty: number }[]): number {
  let total = 0;
  for (const item of items) total += item.price * item.qty;
  return total;
}`;

const DECIMAL_LIB = `import { Decimal } from "decimal.js";
export function isFree(price: number): boolean {
  return price.toFixed(2) === new Decimal(0).toFixed(2);
}`;

const PLAIN_SUM = `export function sumValues(values: number[]): number {
  let sum = 0;
  for (const value of values) sum += value;
  return sum;
}`;

describe("floating money arithmetic evidence", () => {
  it("flags float accumulation over money-named bindings", () => {
    const candidate = candidateFor(FLOAT_TOTAL, "total +=");
    const evidence = buildFloatingMoneyArithmeticEvidence(candidate, [
      { filePath: "src/cart.ts", source: FLOAT_TOTAL },
    ]);
    expect(evidence).toMatchObject({
      function: { name: "cartTotal", exported: true },
      decimalLibrary: null,
      hasMinorUnitHandling: false,
    });
    expect(evidence?.moneyNames).toEqual(expect.arrayContaining(["total", "price"]));
    expect(evidence?.operations.length).toBeGreaterThan(0);
  });

  it("records decimal-library usage on the path", () => {
    const candidate = candidateFor(DECIMAL_LIB, "isFree");
    const evidence = buildFloatingMoneyArithmeticEvidence(candidate, [
      { filePath: "src/cart.ts", source: DECIMAL_LIB },
    ]);
    expect(evidence?.decimalLibrary).toBe("decimal.js");
    expect(evidence?.usesToFixedComparison).toBe(true);
  });

  it("abstains when no money-named arithmetic exists", () => {
    const candidate = candidateFor(PLAIN_SUM, "sumValues");
    expect(buildFloatingMoneyArithmeticEvidence(candidate, [
      { filePath: "src/cart.ts", source: PLAIN_SUM },
    ])).toBeUndefined();
  });
});
