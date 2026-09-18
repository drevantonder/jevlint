import { describe, expect, it } from "vitest";
import { analyzeFile } from "../src/analyze.js";
import { extractCandidates } from "../src/candidates.js";
import { defaultConfig } from "../src/config.js";
import { buildUnmeasuredPerformanceMachineryEvidence } from "../src/evidence/unmeasured-performance-machinery.js";
import type { UnmeasuredPerformanceMachineryEvidence } from "../src/evidence/unmeasured-performance-machinery.js";
import type { EvaluationRequest, Evaluator, JevLintConfig } from "../src/types.js";

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

const accumulator = `export function summarize(rows: Row[]) {
  const totals = new Map<string, number>();
  for (const row of rows) {
    totals.set(row.region, (totals.get(row.region) ?? 0) + row.amount);
  }
  return totals;
}
`;

const contentHashCache = `import { createHash } from "node:crypto";
const store = new Map<string, string>();
export function renderCached(template: string) {
  const key = createHash("sha256").update(template).digest("hex");
  const hit = store.get(key);
  if (hit !== undefined) return hit;
  const html = render(template);
  store.set(key, html);
  return html;
}
`;

const limitFitBatching = `import { chunk } from "./chunk.js";
// Acme API limit: at most 100 records per upsert request.
const MAX_UPSERT_BATCH = 100;
export async function syncUsers(users: User[]) {
  for (const group of chunk(users, MAX_UPSERT_BATCH)) {
    await acmeClient.upsert(group);
  }
}
`;

class FixedEvaluator implements Evaluator {
  requests: EvaluationRequest[] = [];
  constructor(private readonly probability: number) {}
  async evaluate(request: EvaluationRequest): Promise<Record<string, number>> {
    this.requests.push(request);
    return Object.fromEntries(
      Object.keys(request.questions).map((id) => [id, this.probability]),
    );
  }
}

const perfRule = defaultConfig.rules["jev/no-unmeasured-performance-machinery"];
if (!perfRule) throw new Error("jev/no-unmeasured-performance-machinery missing from defaults");

const ruleOnlyConfig: JevLintConfig = {
  rules: { "jev/no-unmeasured-performance-machinery": perfRule },
};

function fullRange(source: string) {
  return [{ start: 1, end: source.split("\n").length }];
}

function requestEvidence(evaluator: FixedEvaluator): UnmeasuredPerformanceMachineryEvidence {
  const evidence = evaluator.requests[0]?.state.candidates[0]?.evidence?.[
    "jev/no-unmeasured-performance-machinery"
  ];
  expect(evidence).toBeDefined();
  // SAFETY: analyzeFile stores this rule's builder output verbatim under its rule id.
  return evidence as UnmeasuredPerformanceMachineryEvidence;
}

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

  it("reads a per-run accumulator as discarded-on-return, not a cache", () => {
    const filePath = "src/reporting.ts";
    const evidence = buildUnmeasuredPerformanceMachineryEvidence(
      candidateFor(accumulator, filePath, "summarize"),
      [{ filePath, source: accumulator }],
    );

    expect(evidence?.machinery.length).toBeGreaterThan(0);
    expect(evidence?.machinery.map(({ kind }) => kind)).toContain("cache-store");
    for (const entry of evidence?.machinery ?? []) {
      expect(entry.motive.lifetime).toBe("per-run");
      expect(entry.motive.lifetimeDetail).toContain("totals");
      expect(entry.motive.stalenessImpossible).toBeNull();
      expect(entry.motive.limitFit).toBeNull();
    }
  });

  it("names the content-hash mechanism on a persistent disk-style cache", () => {
    const filePath = "src/rendering.ts";
    const evidence = buildUnmeasuredPerformanceMachineryEvidence(
      candidateFor(contentHashCache, filePath, "renderCached"),
      [{ filePath, source: contentHashCache }],
    );

    const stores = evidence?.machinery.filter(({ kind }) => kind === "cache-store") ?? [];
    expect(stores.length).toBeGreaterThan(0);
    for (const entry of stores) {
      expect(entry.motive.lifetime).toBe("persistent");
      expect(entry.motive.stalenessImpossible).toContain("content-hash key");
      expect(entry.motive.stalenessImpossible).toContain("key");
    }
  });

  it("names the provider limit behind limit-fitting batching", () => {
    const filePath = "src/sync.ts";
    const evidence = buildUnmeasuredPerformanceMachineryEvidence(
      candidateFor(limitFitBatching, filePath, "syncUsers"),
      [{ filePath, source: limitFitBatching }],
    );

    const batches = evidence?.machinery.filter(({ kind }) => kind === "batch-layer") ?? [];
    expect(batches.length).toBeGreaterThan(0);
    for (const entry of batches) {
      expect(entry.motive.limitFit).toContain("MAX_UPSERT_BATCH");
      expect(entry.motive.stalenessImpossible).toBeNull();
    }
  });

  it("leaves a genuine unmeasured cache without motive counter-signals", () => {
    const filePath = "src/pricing.ts";
    const evidence = buildUnmeasuredPerformanceMachineryEvidence(
      candidateFor(cached, filePath, "formatTotal"),
      [{ filePath, source: cached }],
    );

    const stores = evidence?.machinery.filter(({ kind }) => kind === "cache-store") ?? [];
    expect(stores.length).toBeGreaterThan(0);
    for (const entry of stores) {
      expect(entry.motive.lifetime).toBe("persistent");
      expect(entry.motive.stalenessImpossible).toBeNull();
      expect(entry.motive.limitFit).toBeNull();
    }
    expect(evidence).toMatchObject({
      invalidationPolicy: null,
      wrappedLooksCheap: true,
      perfEvidenceInRepo: [],
    });
  });

  it("carries motive facts and raw scores through review unfiltered", async () => {
    const filePath = "src/pricing.ts";
    const smellyEvaluator = new FixedEvaluator(0.62);
    const smellyJudgments = await analyzeFile({
      filePath,
      source: cached,
      changedLines: fullRange(cached),
      config: ruleOnlyConfig,
      projectFiles: [{ filePath, source: cached }],
    }, smellyEvaluator);

    expect(smellyJudgments).toHaveLength(1);
    expect(smellyJudgments[0]?.probability).toBe(0.62);
    const smellyEvidence = requestEvidence(smellyEvaluator);
    expect(smellyEvidence.machinery.some(({ motive }) => motive.lifetime === "persistent")).toBe(true);

    const accumulatorEvaluator = new FixedEvaluator(0.18);
    const accumulatorJudgments = await analyzeFile({
      filePath: "src/reporting.ts",
      source: accumulator,
      changedLines: fullRange(accumulator),
      config: ruleOnlyConfig,
      projectFiles: [{ filePath: "src/reporting.ts", source: accumulator }],
    }, accumulatorEvaluator);

    expect(accumulatorJudgments).toHaveLength(1);
    expect(accumulatorJudgments[0]?.probability).toBe(0.18);
    const accumulatorEvidence = requestEvidence(accumulatorEvaluator);
    expect(accumulatorEvidence.machinery.some(
      ({ motive }) => motive.lifetime === "per-run",
    )).toBe(true);
  });
});
