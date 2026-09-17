import { describe, expect, it } from "vitest";
import { extractCandidates } from "../src/candidates.js";
import { buildUnconsumedTelemetryEvidence } from "../src/evidence/unconsumed-telemetry.js";

const emitting = `import { metrics } from "./telemetry";
export function placeOrder(order: Order) {
  metrics.increment("order.created");
  return save(order);
}
`;

const dashboard = {
  filePath: "ops/dashboards/orders.json",
  source: `{"panels": [{"targets": [{"expr": "sum(order.created)"}], "title": "Orders"}]}`,
};

const silent = `export function placeOrder(order: Order) {
  return save(order);
}
`;

function candidateFor(source: string, filePath: string, marker: string) {
  const candidate = extractCandidates(filePath, source)
    .find(({ kind, source: text }) => kind === "function" && text.includes(marker));
  expect(candidate).toBeDefined();
  return candidate!;
}

describe("unconsumed telemetry evidence", () => {
  it("extracts an emission with no in-repository consumer", () => {
    const filePath = "src/orders.ts";
    const evidence = buildUnconsumedTelemetryEvidence(
      candidateFor(emitting, filePath, "placeOrder"),
      [{ filePath, source: emitting }],
    );

    expect(evidence).toMatchObject({
      function: { name: "placeOrder" },
      emissions: [{ kind: "metric", name: "order.created" }],
      consumers: [],
    });
  });

  it("records a dashboard that consumes the emitted name", () => {
    const filePath = "src/orders.ts";
    const evidence = buildUnconsumedTelemetryEvidence(
      candidateFor(emitting, filePath, "placeOrder"),
      [{ filePath, source: emitting }, dashboard],
    );

    expect(evidence?.consumers.map(({ filePath: path }) => path))
      .toContain("ops/dashboards/orders.json");
  });

  it("abstains when nothing is emitted", () => {
    const filePath = "src/orders.ts";
    expect(buildUnconsumedTelemetryEvidence(
      candidateFor(silent, filePath, "placeOrder"),
      [{ filePath, source: silent }],
    )).toBeUndefined();
  });
});
