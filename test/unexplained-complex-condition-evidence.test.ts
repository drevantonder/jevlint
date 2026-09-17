import { describe, expect, it } from "vitest";
import { extractCandidates } from "../src/candidates.js";
import { buildUnexplainedComplexConditionEvidence } from "../src/evidence/unexplained-complex-condition.js";
import type { ProjectFile } from "../src/types.js";

const dense = `export function eligible(user: User) {
  if (user.age >= 18 && user.verified && user.region === "eu" && !user.suspended && user.balance > 0 && user.tier !== "trial") {
    return grant(user);
  }
  return deny(user);
}
`;

const grouped = `export function eligible(user: User) {
  const adultResident = user.age >= 18 && user.region === "eu" && user.verified;
  if (adultResident && !user.suspended && user.balance > 0) {
    return grant(user);
  }
  return deny(user);
}
`;

const simple = `export function eligible(user: User) {
  if (user.verified && user.age >= 18) {
    return grant(user);
  }
  return deny(user);
}
`;

function project(source: string, filePath = "src/eligibility.ts"): ProjectFile[] {
  return [{ filePath, source }];
}

function candidateFor(source: string, filePath: string, marker: string) {
  const candidate = extractCandidates(filePath, source)
    .find(({ kind, source: text }) => kind === "function" && text.includes(marker));
  expect(candidate).toBeDefined();
  return candidate!;
}

describe("unexplained complex condition evidence", () => {
  it("records a six-clause condition with no explanatory locals", () => {
    const filePath = "src/eligibility.ts";
    const evidence = buildUnexplainedComplexConditionEvidence(candidateFor(dense, filePath, "eligible"), project(dense, filePath));

    expect(evidence).toMatchObject({
      function: { name: "eligible", exported: true },
    });
    expect(evidence?.conditions).toHaveLength(1);
    expect(evidence?.conditions[0]?.logicalOperators).toBe(5);
    expect(evidence?.explanatoryLocals).toEqual([]);
  });

  it("still reaches evaluation when one clause group has a name", () => {
    const filePath = "src/eligibility.ts";
    const evidence = buildUnexplainedComplexConditionEvidence(candidateFor(grouped, filePath, "eligible"), project(grouped, filePath));

    expect(evidence?.conditions).toHaveLength(1);
    expect(evidence?.explanatoryLocals.map(({ name }) => name)).toEqual(["adultResident"]);
  });

  it("abstains for a two-clause condition", () => {
    const filePath = "src/eligibility.ts";
    expect(buildUnexplainedComplexConditionEvidence(candidateFor(simple, filePath, "eligible"), project(simple, filePath))).toBeUndefined();
  });

  it("abstains for non-function candidates", () => {
    const filePath = "src/eligibility.ts";
    const candidate = { ...candidateFor(dense, filePath, "eligible"), kind: "change" as const };
    expect(buildUnexplainedComplexConditionEvidence(candidate, project(dense, filePath))).toBeUndefined();
  });
});
