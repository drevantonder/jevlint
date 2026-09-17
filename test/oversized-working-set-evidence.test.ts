import { describe, expect, it } from "vitest";
import { extractCandidates } from "../src/candidates.js";
import { defaultConfig } from "../src/config.js";
import { buildRuleEvidence } from "../src/evidence/index.js";
import { buildOversizedWorkingSetEvidence } from "../src/evidence/oversized-working-set.js";
import type { ProjectFile } from "../src/types.js";

const RULE = "jev/no-oversized-working-set";

const interleaved = `export function quote(order: Order) {
  const items = order.items;
  const currency = order.currency;
  const discount = loadDiscount(order.customer);
  const tax = loadTax(order.region);
  const shipping = loadShipping(order.weight);
  const gift = order.gift ? wrap(order.gift) : null;
  const notes = order.notes ?? "";
  return format(items, currency, discount, tax, shipping, gift, notes);
}
`;

const pipeline = `export function quote(order: Order) {
  const items = order.items;
  const priced = priceEach(items);
  const discounted = applyDiscount(priced, order.customer);
  const taxed = applyTax(discounted, order.region);
  return format(taxed);
}
`;

const tiny = `export function double(value: number) {
  return value * 2;
}
`;

function project(source: string, filePath = "src/quote.ts"): ProjectFile[] {
  return [{ filePath, source }];
}

function candidateFor(source: string, filePath: string, marker: string) {
  const candidate = extractCandidates(filePath, source)
    .find(({ kind, source: text }) => kind === "function" && text.includes(marker));
  expect(candidate).toBeDefined();
  return candidate!;
}

describe("oversized working set evidence", () => {
  it("ships as a function judgment without thresholds", () => {
    expect(defaultConfig.rules[RULE]).toMatchObject({
      scope: "function",
      message: expect.any(String),
    });
    expect(defaultConfig.rules[RULE]).not.toHaveProperty("threshold");
    expect(defaultConfig.rules[RULE]).not.toHaveProperty("severity");
  });

  it("inventories interleaved values with concurrent liveness", () => {
    const filePath = "src/quote.ts";
    const evidence = buildOversizedWorkingSetEvidence(
      candidateFor(interleaved, filePath, "quote"),
      project(interleaved, filePath),
    );

    expect(evidence).toMatchObject({
      function: { name: "quote", exported: true },
      totalBindings: 8,
      longestFeedChain: 2,
    });
    expect(evidence!.maxConcurrentLive).toBeGreaterThanOrEqual(7);
    expect(evidence?.bindings.map(({ name }) => name)).toContain("discount");
  });

  it("keeps single-pipeline transforms eligible with the feed chain recorded", () => {
    const filePath = "src/quote.ts";
    const evidence = buildOversizedWorkingSetEvidence(
      candidateFor(pipeline, filePath, "quote"),
      project(pipeline, filePath),
    );

    expect(evidence).toMatchObject({
      function: { name: "quote" },
      totalBindings: 5,
    });
    expect(evidence!.longestFeedChain).toBeGreaterThanOrEqual(4);
  });

  it("abstains when the working set holds almost nothing", () => {
    const filePath = "src/double.ts";
    expect(buildOversizedWorkingSetEvidence(
      candidateFor(tiny, filePath, "double"),
      project(tiny, filePath),
    )).toBeUndefined();
  });

  it("routes through the shared dispatch", () => {
    const filePath = "src/quote.ts";
    const files = project(interleaved, filePath);
    const result = buildRuleEvidence(
      RULE,
      candidateFor(interleaved, filePath, "quote"),
      files,
    );

    expect(result).toEqual({ handled: true, evidence: expect.any(Object) });
  });
});
