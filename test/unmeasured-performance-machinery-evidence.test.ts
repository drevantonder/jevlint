import { describe, expect, it } from "vitest";
import { extractCandidates } from "../src/candidates.js";
import { buildUnmeasuredPerformanceMachineryEvidence } from "../src/evidence/unmeasured-performance-machinery.js";

const cached = `const cache = new Map<string, number>();
export function formatTotal(items: Item[]) {
  const key = items.length.toString();
  if (cache.has(key)) {
    return cache.get(key) as number;
  }
  const total = items.length * 2;
  cache.set(key, total);
  return total;
}
`;

const measured = `import { useMemo } from "react";
export function usePriced(cart: Cart) {
  return useMemo(() => priceCart(cart), [cart.id]);
}
`;

const benchFile = {
  filePath: "bench/pricing.bench.ts",
  source: `import { bench } from "vitest";
bench("usePriced hotspot", () => usePriced(cart));
`,
};

const plain = `export function formatTotal(items: Item[]) {
  return items.length * 2;
}
`;

function candidateFor(source: string, filePath: string, marker: string) {
  const candidate = extractCandidates(filePath, source)
    .find(({ kind, source: text }) => kind === "function" && text.includes(marker));
  expect(candidate).toBeDefined();
  return candidate!;
}

describe("unmeasured performance machinery evidence", () => {
  it("extracts a bespoke cache around a cheap helper with no invalidation", () => {
    const filePath = "src/pricing.ts";
    const evidence = buildUnmeasuredPerformanceMachineryEvidence(
      candidateFor(cached, filePath, "formatTotal"),
      [{ filePath, source: cached }],
    );

    expect(evidence).toMatchObject({
      function: { name: "formatTotal" },
      invalidationPolicy: null,
      wrappedLooksCheap: true,
      perfEvidenceInRepo: [],
    });
    expect(evidence?.machinery.length).toBeGreaterThan(0);
    expect(evidence?.machinery.map(({ kind }) => kind)).toContain("cache-store");
  });

  it("records benchmark references beside memoization", () => {
    const filePath = "src/pricing.ts";
    const evidence = buildUnmeasuredPerformanceMachineryEvidence(
      candidateFor(measured, filePath, "usePriced"),
      [{ filePath, source: measured }, benchFile],
    );

    expect(evidence?.machinery.map(({ kind }) => kind)).toContain("memo-hook");
    expect(evidence?.perfEvidenceInRepo.length).toBeGreaterThan(0);
  });

  it("abstains when no perf machinery appears", () => {
    const filePath = "src/pricing.ts";
    expect(buildUnmeasuredPerformanceMachineryEvidence(
      candidateFor(plain, filePath, "formatTotal"),
      [{ filePath, source: plain }],
    )).toBeUndefined();
  });
});
