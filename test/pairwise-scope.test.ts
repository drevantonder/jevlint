import { describe, expect, it } from "vitest";
import { extractCandidates } from "../src/candidates.js";
import { buildCoincidentalSimilarityEvidence } from "../src/evidence/coincidental-similarity.js";
import { buildDuplicatedLogicEvidence } from "../src/evidence/duplicated-logic.js";
import { buildParaphrasedSiblingLogicEvidence } from "../src/evidence/paraphrased-sibling-logic.js";
import {
  applyComparisonBudget,
  lineStartOffsets,
  orderScopeFiles,
  positionAt,
  rankComparisons,
  setPairwiseScopeOverrides,
} from "../src/evidence/pairwise-scope.js";
import type { ProjectFile } from "../src/types.js";

function historicalPosition(source: string, offset: number) {
  let line = 1;
  let column = 1;
  for (let index = 0; index < offset; index += 1) {
    if (source[index] === "\n") {
      line += 1;
      column = 1;
    } else {
      column += 1;
    }
  }
  return { line, column };
}

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

const files: ProjectFile[] = [
  { filePath: "src/invoice.ts", source: invoiceSource },
  { filePath: "src/receipt.ts", source: receiptSource },
  { filePath: "src/checkout.ts", source: checkoutSource },
];

function candidateOf(source: string, filePath: string) {
  const found = extractCandidates(filePath, source).find(({ kind }) => kind === "function");
  expect(found).toBeDefined();
  if (!found) throw new Error("fixture candidate missing");
  return found;
}

describe("pairwise scope line offsets", () => {
  it("matches the historical char-scan on every offset, including carriage returns", () => {
    const source = "const a = 1;\r\n\r\nfunction f() {\n  return a;\n}\n";
    const starts = lineStartOffsets(source);
    for (let offset = 0; offset <= source.length; offset += 1) {
      expect(positionAt(source, starts, offset)).toEqual(historicalPosition(source, offset));
    }
  });
});

describe("pairwise scope ordering", () => {
  const project: ProjectFile[] = [
    { filePath: "src/a.ts", source: "" },
    { filePath: "src/b.ts", source: "" },
    { filePath: "src/c.ts", source: "" },
    { filePath: "src/d.ts", source: "" },
  ];

  it("puts the owner first, then related modules, then the rest in project order", () => {
    const scope = orderScopeFiles("src/c.ts", project, new Set(["src/a.ts"]), 40);
    expect(scope.files.map((file) => file.filePath)).toEqual([
      "src/c.ts",
      "src/a.ts",
      "src/b.ts",
      "src/d.ts",
    ]);
    expect(scope.bounded).toBe(false);
  });

  it("truncates deterministically while always keeping the owner", () => {
    const scope = orderScopeFiles("src/d.ts", project, new Set(["src/a.ts"]), 2);
    expect(scope.files.map((file) => file.filePath)).toEqual(["src/d.ts", "src/a.ts"]);
    expect(scope.bounded).toBe(true);
  });
});

describe("pairwise comparison budget", () => {
  const entry = (score: number, sequenceMatch: boolean) => ({
    // SAFETY: rankComparisons only reads entry.node and entry.name; the test
    // never reaches fingerprinting, so a minimal stand-in node suffices.
    entry: { node: { start: score, end: score + 1 } as never, name: `fn${score}` },
    opcodes: [],
    sequenceMatch,
    score,
  });

  it("selects everything when the enumeration fits the budget", () => {
    const ranked = [entry(1, false), entry(5, false)];
    expect(applyComparisonBudget(ranked, 2, true)).toEqual({ selected: ranked, bounded: false });
  });

  it("leads with exact sequence matches and then the best cheap scores", () => {
    const ranked = [entry(9, false), entry(1, true), entry(7, false), entry(3, false)];
    const budget = applyComparisonBudget(ranked, 2, true);
    expect(budget.bounded).toBe(true);
    expect(budget.selected).toEqual([entry(1, true), entry(9, false)]);
  });

  it("flags an identical statement sequence of length three or more", () => {
    const opcodes = ["VariableDeclaration", "ForOfStatement", "ReturnStatement"];
    const [ranked] = rankComparisons(opcodes, "formatInvoice", [
      // SAFETY: topLevelOpcodes is not exercised here; only the score path
      // runs, so a bodyless stand-in node suffices.
      { node: { body: undefined, start: 0, end: 1 } as never, name: "formatReceipt" },
    ]);
    expect(ranked?.score).toBeGreaterThan(0);
  });

  it("drops the vocabulary term when the weight is zero", () => {
    const opcodes = ["VariableDeclaration", "ReturnStatement"];
    const entries = [
      // SAFETY: score-only path; stand-in nodes never reach fingerprinting.
      { node: { body: undefined, start: 0, end: 1 } as never, name: "formatInvoice" },
      // SAFETY: as above; the second stand-in likewise never leaves the rank step.
      { node: { body: undefined, start: 2, end: 3 } as never, name: "unrelatedBrowsing" },
    ];
    const [same, other] = rankComparisons(opcodes, "formatInvoice", entries);
    expect(same?.score).toBeGreaterThan(other?.score ?? 0);
    const [sameUnweighted, otherUnweighted] = rankComparisons(opcodes, "formatInvoice", entries, 0);
    expect(sameUnweighted?.score).toBe(otherUnweighted?.score);
  });
});

describe("pairwise bounded evidence", () => {
  const candidate = candidateOf(invoiceSource, "src/invoice.ts");

  it("keeps the same-module-shaped match under a budget of one full comparison", () => {
    setPairwiseScopeOverrides({
      maxScopeFiles: 40,
      maxFullComparisons: 1,
      maxCallerResolutions: 12,
      prePass: true,
    });
    try {
      const evidence = buildDuplicatedLogicEvidence(candidate, files);
      expect(evidence?.matches.map((match) => match.functionName)).toContain("formatReceipt");
    } finally {
      setPairwiseScopeOverrides(undefined);
    }
  });

  it("reports identical evidence with and without the pre-pass below the budgets", () => {
    const open = { maxScopeFiles: 10_000, maxFullComparisons: 10_000, maxCallerResolutions: 10_000, prePass: false };
    const withDefaults = [
      buildDuplicatedLogicEvidence(candidate, files),
      buildCoincidentalSimilarityEvidence(candidate, files),
      buildParaphrasedSiblingLogicEvidence(candidate, files),
    ];
    setPairwiseScopeOverrides(open);
    try {
      expect(buildDuplicatedLogicEvidence(candidate, files)).toEqual(withDefaults[0]);
      expect(buildCoincidentalSimilarityEvidence(candidate, files)).toEqual(withDefaults[1]);
      expect(buildParaphrasedSiblingLogicEvidence(candidate, files)).toEqual(withDefaults[2]);
    } finally {
      setPairwiseScopeOverrides(undefined);
    }
  });
});
