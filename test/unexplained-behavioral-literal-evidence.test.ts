import { describe, expect, it } from "vitest";
import { analyzeFile } from "../src/analyze.js";
import { extractCandidates } from "../src/candidates.js";
import { defaultConfig } from "../src/config.js";
import { buildRuleEvidence } from "../src/evidence/index.js";
import { buildUnexplainedBehavioralLiteralEvidence } from "../src/evidence/unexplained-behavioral-literal.js";
import type { EvaluationRequest, Evaluator, JevLintConfig, ProjectFile } from "../src/types.js";

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

const emptyEquality = `export function hasItems(count: number) {
  return count !== 0;
}
`;

const emptyLength = `export function isEmpty(items: string[]) {
  if (items.length === 0) return true;
  return false;
}
`;

const lengthNonzero = `export function hasItems(items: string[]) {
  return items.length > 0;
}
`;

const typeofGuard = `export function describe(input: unknown) {
  if (typeof input === "string") return "text";
  return "other";
}
`;

const closedSetFlags = `export function label(status: string) {
  if (status === "active") return 1;
  if (status === "archived") return 2;
  return 0;
}
`;

const soloFlag = `export function isActive(status: string) {
  return status === "active";
}
`;

const coupledTriple = `export function truncate(items: string[]) {
  if (items.length > 10) {
    const rest = items.length - 10;
    return { head: items.slice(0, 10), rest };
  }
  return { head: items, rest: 0 };
}
`;

class CouplingAssertingEvaluator implements Evaluator {
  requests: EvaluationRequest[] = [];

  async evaluate(request: EvaluationRequest): Promise<Record<string, number>> {
    this.requests.push(request);
    return Object.fromEntries(Object.keys(request.questions).map((id) => [id, 0.85]));
  }
}


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

  it("carries no coupling fact for a solo magic number", () => {
    const filePath = "src/retry.ts";
    const evidence = buildUnexplainedBehavioralLiteralEvidence(
      candidateFor(steering, filePath, "attempts"),
      project(steering, filePath),
    );

    expect(evidence?.couplings).toEqual([]);
  });

  it("abstains on zero-equality emptiness checks", () => {
    const filePath = "src/items.ts";
    expect(buildUnexplainedBehavioralLiteralEvidence(
      candidateFor(emptyEquality, filePath, "hasItems"),
      project(emptyEquality, filePath),
    )).toBeUndefined();
  });

  it("abstains on .length emptiness checks", () => {
    const emptyPath = "src/empty.ts";
    expect(buildUnexplainedBehavioralLiteralEvidence(
      candidateFor(emptyLength, emptyPath, "isEmpty"),
      project(emptyLength, emptyPath),
    )).toBeUndefined();
    const nonzeroPath = "src/nonzero.ts";
    expect(buildUnexplainedBehavioralLiteralEvidence(
      candidateFor(lengthNonzero, nonzeroPath, "hasItems"),
      project(lengthNonzero, nonzeroPath),
    )).toBeUndefined();
  });

  it("abstains on typeof guards", () => {
    const filePath = "src/describe.ts";
    expect(buildUnexplainedBehavioralLiteralEvidence(
      candidateFor(typeofGuard, filePath, "describe"),
      project(typeofGuard, filePath),
    )).toBeUndefined();
  });

  it("abstains on closed-set flag equality", () => {
    const filePath = "src/label.ts";
    expect(buildUnexplainedBehavioralLiteralEvidence(
      candidateFor(closedSetFlags, filePath, "label"),
      project(closedSetFlags, filePath),
    )).toBeUndefined();
  });

  it("keeps a solo flag equality eligible", () => {
    const filePath = "src/active.ts";
    const evidence = buildUnexplainedBehavioralLiteralEvidence(
      candidateFor(soloFlag, filePath, "isActive"),
      project(soloFlag, filePath),
    );

    expect(evidence?.literals).toMatchObject([
      { value: '"active"', position: "equality", binding: "status" },
    ]);
    expect(evidence?.couplings).toEqual([]);
  });

  it("names co-sites for the coupled triple", () => {
    const filePath = "src/truncate.ts";
    const evidence = buildUnexplainedBehavioralLiteralEvidence(
      candidateFor(coupledTriple, filePath, "truncate"),
      project(coupledTriple, filePath),
    );

    expect(evidence?.literals.map(({ value }) => value).sort()).toEqual(["10", "10"]);
    expect(evidence?.couplings).toHaveLength(1);
    const [coupling] = evidence?.couplings ?? [];
    expect(coupling?.value).toBe("10");
    expect(coupling?.sites).toHaveLength(3);
    const texts = (coupling?.sites ?? []).map(({ expression }) => expression).sort();
    expect(texts).toEqual([
      "items.length - 10",
      "items.length > 10",
      "items.slice(0, 10)",
    ]);
  });

  it("hands the coupling fact to the evaluator instead of a live call", async () => {
    const filePath = "src/truncate.ts";
    const rule = defaultConfig.rules[RULE];
    expect(rule).toBeDefined();
    if (!rule) return;
    const config: JevLintConfig = { rules: { [RULE]: rule } };
    const evaluator = new CouplingAssertingEvaluator();
    const judgments = await analyzeFile({
      filePath,
      source: coupledTriple,
      changedLines: [{ start: 1, end: coupledTriple.split("\n").length }],
      config,
      projectFiles: project(coupledTriple, filePath),
    }, evaluator);

    expect(judgments.map(({ ruleId }) => ruleId)).toContain(RULE);
    expect(evaluator.requests).toHaveLength(1);
    expect(evaluator.requests[0]?.state.candidates[0]?.evidence?.[RULE]).toMatchObject({
      literals: expect.any(Array),
      couplings: [{
        value: "10",
        sites: [expect.any(Object), expect.any(Object), expect.any(Object)],
      }],
    });
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
