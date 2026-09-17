import { describe, expect, it } from "vitest";
import { extractCandidates } from "../src/candidates.js";
import { buildFloatingMoneyArithmeticEvidence } from "../src/evidence/floating-money-arithmetic.js";
import { buildHandRolledNumberFormatEvidence } from "../src/evidence/hand-rolled-number-format.js";
import type { ProjectFile } from "../src/types.js";

const SMELLY = `export function formatGrouped(value: number): string {
  const fixed = value.toFixed(2);
  const grouped = fixed.replace(/\\B(?=(\\d{3})+(?!\\d))/g, ",");
  return "$" + grouped;
}
`;

const MONEY_MATH = `export function addTax(price: number, rate: number): number {
  return price + price * rate;
}
`;

const PLAIN_FIXED = `export function fixedTwo(value: number): string {
  return value.toFixed(2);
}
`;

function candidateFor(source: string, marker: string, extra: ProjectFile[] = []) {
  const filePath = "src/money.ts";
  const projectFiles: ProjectFile[] = [{ filePath, source }, ...extra];
  const candidate = extractCandidates(filePath, source)
    .find(({ kind, source: text }) => kind === "function" && text.includes(marker));
  expect(candidate).toBeDefined();
  return { candidate: candidate!, projectFiles };
}

describe("hand-rolled number format evidence", () => {
  it("reports regex grouping with currency prefixing", () => {
    const { candidate, projectFiles } = candidateFor(SMELLY, "formatGrouped", [{
      filePath: "src/other.ts",
      source: "export const formatter = new Intl.NumberFormat(\"en-US\");\n",
    }]);

    const evidence = buildHandRolledNumberFormatEvidence(candidate, projectFiles);

    expect(evidence).toMatchObject({
      function: { name: "formatGrouped" },
      techniques: expect.arrayContaining([
        "thousand-separator-regex",
        "manual-currency-prefix",
      ]),
      currencySymbols: ["$"],
      usesIntlNumberFormat: false,
      intlNumberShelf: ["src/other.ts"],
    });
  });

  it("abstains on a bare toFixed with no separator or currency assembly", () => {
    const { candidate, projectFiles } = candidateFor(PLAIN_FIXED, "fixedTwo");

    expect(buildHandRolledNumberFormatEvidence(candidate, projectFiles)).toBeUndefined();
  });

  it("splits from money arithmetic: formatting here, math there", () => {
    const { candidate, projectFiles } = candidateFor(SMELLY, "formatGrouped");
    expect(buildHandRolledNumberFormatEvidence(candidate, projectFiles)).toBeDefined();
    expect(buildFloatingMoneyArithmeticEvidence(candidate, projectFiles)).toBeUndefined();

    const math = candidateFor(MONEY_MATH, "addTax");
    expect(buildFloatingMoneyArithmeticEvidence(math.candidate, math.projectFiles)).toBeDefined();
    expect(buildHandRolledNumberFormatEvidence(math.candidate, math.projectFiles)).toBeUndefined();
  });
});
