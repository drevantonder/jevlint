import { describe, expect, it } from "vitest";
import { extractCandidates } from "../src/candidates.js";
import { buildDeepHappyPathNestingEvidence } from "../src/evidence/deep-happy-path-nesting.js";
import type { ProjectFile } from "../src/types.js";

const smelly = `export function price(order: Order) {
  if (order) {
    if (order.items) {
      if (order.items.length > 0) {
        return total(order);
      }
    }
  }
  return 0;
}
`;

const elseChains = `export function route(state: string) {
  if (state === "a") {
    return first(state);
  } else if (state === "b") {
    if (ready()) {
      if (allowed()) {
        return dispatch(state);
      }
    }
    return wait();
  } else {
    return reject(state);
  }
}
`;

const flattened = `export function price(order: Order) {
  if (!order?.items?.length) return 0;
  return total(order);
}
`;

const noReturn = `export function record(order: Order) {
  metrics.count(order.items.length);
}
`;

function project(source: string, filePath = "src/pricing.ts"): ProjectFile[] {
  return [{ filePath, source }];
}

function candidateFor(source: string, filePath: string, marker: string) {
  const candidate = extractCandidates(filePath, source)
    .find(({ kind, source: text }) => kind === "function" && text.includes(marker));
  expect(candidate).toBeDefined();
  return candidate!;
}

describe("deep happy path nesting evidence", () => {
  it("measures the depth of the buried nominal return", () => {
    const filePath = "src/pricing.ts";
    const evidence = buildDeepHappyPathNestingEvidence(candidateFor(smelly, filePath, "price"), project(smelly, filePath));

    expect(evidence).toMatchObject({
      function: { name: "price", exported: true },
      maxReturnDepth: 3,
      elseChainCount: 0,
      hasSwitchDispatch: false,
    });
    expect(evidence?.returns.map(({ depth }) => depth).sort()).toEqual([0, 3]);
  });

  it("counts else chains carrying the main logic inward", () => {
    const filePath = "src/routing.ts";
    const evidence = buildDeepHappyPathNestingEvidence(
      candidateFor(elseChains, filePath, "route"),
      project(elseChains, filePath),
    );

    expect(evidence?.maxReturnDepth).toBe(4);
    expect(evidence?.elseChainCount).toBe(1);
  });

  it("abstains when guards keep the nominal path shallow", () => {
    const filePath = "src/pricing.ts";
    expect(buildDeepHappyPathNestingEvidence(
      candidateFor(flattened, filePath, "price"),
      project(flattened, filePath),
    )).toBeUndefined();
  });

  it("abstains when the function never returns", () => {
    const filePath = "src/metrics.ts";
    expect(buildDeepHappyPathNestingEvidence(
      candidateFor(noReturn, filePath, "record"),
      project(noReturn, filePath),
    )).toBeUndefined();
  });

  it("includes callers for nominal-path reliance", () => {
    const filePath = "src/pricing.ts";
    const files: ProjectFile[] = [
      { filePath, source: smelly },
      {
        filePath: "src/checkout.ts",
        source: `import { price } from "./pricing";\nexport function quote(o: never) { return price(o); }`,
      },
    ];
    const evidence = buildDeepHappyPathNestingEvidence(candidateFor(smelly, filePath, "price"), files);
    expect(evidence?.callers).toMatchObject([{ filePath: "src/checkout.ts" }]);
  });
});
