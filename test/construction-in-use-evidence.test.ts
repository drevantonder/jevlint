import { describe, expect, it } from "vitest";
import { extractCandidates } from "../src/candidates.js";
import { buildConstructionInUseEvidence } from "../src/evidence/construction-in-use.js";
import type { ProjectFile } from "../src/types.js";

const orderSource = `import { PostgresStore } from "./store.js";

export function processOrder(order: Order): void {
  const store = new PostgresStore(connectionString);
  store.save(order);
}

export function listOrders(store: PostgresStore): Order[] {
  return store.all();
}
`;

const callerSource = `import { processOrder } from "./order.js";
import { PostgresStore } from "./store.js";

export function retryOrder(order: Order): void {
  const store = new PostgresStore(connectionString);
  try {
    processOrder(order);
  } catch {
    store.save(order);
  }
}
`;

const factorySource = `import { PostgresStore } from "./store.js";

export function createStore(): PostgresStore {
  return new PostgresStore(connectionString);
}
`;

const valueSource = `export function total(items: number[]): Money {
  return new Money(items.length, "USD");
}
`;

function candidate(source: string, filePath: string) {
  return extractCandidates(filePath, source).find(({ kind }) => kind === "function");
}

describe("construction in use evidence", () => {
  it("extracts inline construction with sibling injection and callers", () => {
    const files: ProjectFile[] = [
      { filePath: "src/order.ts", source: orderSource },
      { filePath: "src/retry.ts", source: callerSource },
    ];
    const fn = candidate(orderSource, "src/order.ts");
    expect(fn).toBeDefined();
    if (!fn) return;

    const evidence = buildConstructionInUseEvidence(fn, files);

    expect(evidence).toMatchObject({
      function: { name: "processOrder", filePath: "src/order.ts" },
      constructions: [expect.objectContaining({
        kind: "new",
        classOrFactory: "PostgresStore",
        importSource: "./store.js",
        assignedTo: "store",
        behaviorUse: "method-call",
      })],
      siblingInjection: expect.objectContaining({ functionName: "listOrders" }),
      callers: [expect.objectContaining({
        filePath: "src/retry.ts",
        call: expect.stringContaining("processOrder("),
      })],
    });
  });

  it("abstains for a factory whose role is construction", () => {
    const fn = candidate(factorySource, "src/store.ts");
    expect(fn).toBeDefined();
    if (!fn) return;

    expect(buildConstructionInUseEvidence(fn, [{ filePath: "src/store.ts", source: factorySource }])).toBeUndefined();
  });

  it("abstains for a value object held as data", () => {
    const fn = candidate(valueSource, "src/total.ts");
    expect(fn).toBeDefined();
    if (!fn) return;

    expect(buildConstructionInUseEvidence(fn, [{ filePath: "src/total.ts", source: valueSource }])).toBeUndefined();
  });
});
