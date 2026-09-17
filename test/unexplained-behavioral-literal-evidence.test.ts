import { describe, expect, it } from "vitest";
import { extractCandidates } from "../src/candidates.js";
import { defaultConfig } from "../src/config.js";
import { buildRuleEvidence } from "../src/evidence/index.js";
import { buildUnexplainedBehavioralLiteralEvidence } from "../src/evidence/unexplained-behavioral-literal.js";
import type { ProjectFile } from "../src/types.js";

const RULE = "jev/no-unexplained-behavioral-literal";

const steering = `export function attempts(count: number, timeout: number) {
  if (count > 7) return "exhausted";
  return timeout * 0.37;
}
`;

const indexArithmetic = `export function next(items: string[], index: number) {
  return items[index + 1] ?? null;
}
`;

const named = `export const MAX_RETRIES = 7;
export function attempts(count: number) {
  if (count > MAX_RETRIES) return "exhausted";
  return "retry";
}
`;

const plain = `export function ready() {
  return 0;
}
`;

function project(source: string, filePath = "src/retry.ts"): ProjectFile[] {
  return [{ filePath, source }];
}

function candidateFor(source: string, filePath: string, marker: string) {
  const candidate = extractCandidates(filePath, source)
    .find(({ kind, source: text }) => kind === "function" && text.includes(marker));
  expect(candidate).toBeDefined();
  return candidate!;
}

describe("unexplained behavioral literal evidence", () => {
  it("ships as a function judgment without thresholds", () => {
    expect(defaultConfig.rules[RULE]).toMatchObject({
      scope: "function",
      message: expect.any(String),
    });
    expect(defaultConfig.rules[RULE]).not.toHaveProperty("threshold");
    expect(defaultConfig.rules[RULE]).not.toHaveProperty("severity");
  });

  it("collects bare steering literals with their positions", () => {
    const filePath = "src/retry.ts";
    const evidence = buildUnexplainedBehavioralLiteralEvidence(
      candidateFor(steering, filePath, "attempts"),
      project(steering, filePath),
    );

    expect(evidence).toMatchObject({
      function: { name: "attempts", exported: true },
      literals: [
        { value: "7", kind: "number", position: "comparison", binding: "count" },
        { value: "0.37", kind: "number", position: "arithmetic", binding: "timeout" },
      ],
    });
  });

  it("keeps loop-style arithmetic eligible as the low-meaning shape", () => {
    const filePath = "src/items.ts";
    const evidence = buildUnexplainedBehavioralLiteralEvidence(
      candidateFor(indexArithmetic, filePath, "next"),
      project(indexArithmetic, filePath),
    );

    expect(evidence?.literals).toMatchObject([
      { value: "1", position: "arithmetic", binding: "index" },
    ]);
  });

  it("abstains when steering values are named constants", () => {
    const filePath = "src/retry.ts";
    const evidence = buildUnexplainedBehavioralLiteralEvidence(
      candidateFor(named, filePath, "attempts"),
      project(named, filePath),
    );

    expect(evidence).toBeUndefined();
  });

  it("abstains when no literal steers behavior", () => {
    const filePath = "src/ready.ts";
    expect(buildUnexplainedBehavioralLiteralEvidence(
      candidateFor(plain, filePath, "ready"),
      project(plain, filePath),
    )).toBeUndefined();
  });

  it("abstains for test files", () => {
    const filePath = "src/retry.test.ts";
    expect(buildUnexplainedBehavioralLiteralEvidence(
      candidateFor(steering, filePath, "attempts"),
      project(steering, filePath),
    )).toBeUndefined();
  });

  it("routes through the shared dispatch", () => {
    const filePath = "src/retry.ts";
    const files = project(steering, filePath);
    const result = buildRuleEvidence(
      RULE,
      candidateFor(steering, filePath, "attempts"),
      files,
    );

    expect(result).toEqual({ handled: true, evidence: expect.any(Object) });
  });
});
