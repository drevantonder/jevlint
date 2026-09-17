import { describe, expect, it } from "vitest";
import { extractCandidates } from "../src/candidates.js";
import { defaultConfig } from "../src/config.js";
import { buildRuleEvidence } from "../src/evidence/index.js";
import { buildNestedConditionalExpressionEvidence } from "../src/evidence/nested-conditional-expression.js";
import type { ProjectFile } from "../src/types.js";

const RULE = "jev/no-nested-conditional-expression";

const nested = `export function label(score: number, kind: string) {
  return score > 90 ? "gold" : score > 70 ? (kind === "exam" ? "silver-exam" : "silver") : "bronze";
}
`;

const chained = `export function visible(user: User, org: Org, feature: Flags) {
  return user.active && org.enabled && feature.beta && !user.suspended;
}
`;

const named = `export function label(score: number) {
  const excellent = score > 90;
  return excellent ? "gold" : "standard";
}
`;

const statements = `export function label(score: number) {
  if (score > 90) return "gold";
  if (score > 70) return "silver";
  return "bronze";
}
`;

function project(source: string, filePath = "src/label.ts"): ProjectFile[] {
  return [{ filePath, source }];
}

function candidateFor(source: string, filePath: string, marker: string) {
  const candidate = extractCandidates(filePath, source)
    .find(({ kind, source: text }) => kind === "function" && text.includes(marker));
  expect(candidate).toBeDefined();
  return candidate!;
}

describe("nested conditional expression evidence", () => {
  it("ships as a function judgment without thresholds", () => {
    expect(defaultConfig.rules[RULE]).toMatchObject({
      scope: "function",
      message: expect.any(String),
    });
    expect(defaultConfig.rules[RULE]).not.toHaveProperty("threshold");
    expect(defaultConfig.rules[RULE]).not.toHaveProperty("severity");
  });

  it("measures nested ternary depth in a return position", () => {
    const filePath = "src/label.ts";
    const evidence = buildNestedConditionalExpressionEvidence(
      candidateFor(nested, filePath, "label"),
      project(nested, filePath),
    );

    expect(evidence).toMatchObject({
      function: { name: "label", exported: true },
      maxConditionalDepth: 3,
    });
    expect(evidence?.sites.filter(({ kind }) => kind === "conditional").length).toBe(3);
    expect(evidence?.sites.every(({ position }) => position === "return")).toBe(true);
  });

  it("records long logical chains in return positions", () => {
    const filePath = "src/visible.ts";
    const evidence = buildNestedConditionalExpressionEvidence(
      candidateFor(chained, filePath, "visible"),
      project(chained, filePath),
    );

    expect(evidence).toMatchObject({
      function: { name: "visible" },
      maxLogicalOperands: 4,
    });
    expect(evidence?.sites).toMatchObject([{ kind: "logical", operands: 4, position: "return" }]);
  });

  it("keeps single conditionals over named booleans eligible with the binding recorded", () => {
    const filePath = "src/label.ts";
    const evidence = buildNestedConditionalExpressionEvidence(
      candidateFor(named, filePath, "label"),
      project(named, filePath),
    );

    expect(evidence).toMatchObject({
      function: { name: "label" },
      maxConditionalDepth: 1,
      namedBooleans: ["excellent"],
    });
  });

  it("abstains for flat statement branching with no conditional expression", () => {
    const filePath = "src/label.ts";
    expect(buildNestedConditionalExpressionEvidence(
      candidateFor(statements, filePath, "label"),
      project(statements, filePath),
    )).toBeUndefined();
  });

  it("routes through the shared dispatch", () => {
    const filePath = "src/label.ts";
    const files = project(nested, filePath);
    const result = buildRuleEvidence(
      RULE,
      candidateFor(nested, filePath, "label"),
      files,
    );

    expect(result).toEqual({ handled: true, evidence: expect.any(Object) });
  });
});
