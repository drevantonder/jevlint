import { describe, expect, it } from "vitest";
import { extractCandidates } from "../src/candidates.js";
import { buildRareCaseFirstEvidence } from "../src/evidence/rare-case-first.js";
import type { ProjectFile } from "../src/types.js";

const smelly = `export function loadUser(id: string) {
  if (id == null) {
    return null;
  } else {
    const record = store.fetch(id);
    const profile = buildProfile(record);
    const session = startSession(profile);
    return session;
  }
}
`;

const balanced = `export function pick(a: number, b: number) {
  if (a > b) {
    return a;
  } else {
    return b;
  }
}
`;

const guard = `export function loadUser(id: string) {
  if (id == null) return null;
  const record = store.fetch(id);
  return buildProfile(record);
}
`;

function project(source: string, filePath = "src/users.ts"): ProjectFile[] {
  return [{ filePath, source }];
}

function candidateFor(source: string, filePath: string, marker: string) {
  const candidate = extractCandidates(filePath, source)
    .find(({ kind, source: text }) => kind === "function" && text.includes(marker));
  expect(candidate).toBeDefined();
  return candidate!;
}

describe("rare case first evidence", () => {
  it("records a null-first branch parking the nominal outcome in else", () => {
    const filePath = "src/users.ts";
    const evidence = buildRareCaseFirstEvidence(candidateFor(smelly, filePath, "loadUser"), project(smelly, filePath));

    expect(evidence).toMatchObject({
      function: { name: "loadUser", exported: true },
    });
    expect(evidence?.branches).toHaveLength(1);
    expect(evidence?.branches[0]?.rareSignals).toContain("nullish-comparison");
    expect(evidence?.branches[0]?.nominalInElse).toBe(true);
  });

  it("abstains when the arms carry balanced likelihood", () => {
    const filePath = "src/pick.ts";
    expect(buildRareCaseFirstEvidence(candidateFor(balanced, filePath, "pick"), project(balanced, filePath))).toBeUndefined();
  });

  it("abstains for an early-return guard with no else", () => {
    const filePath = "src/users.ts";
    expect(buildRareCaseFirstEvidence(candidateFor(guard, filePath, "loadUser"), project(guard, filePath))).toBeUndefined();
  });

  it("abstains for non-function candidates", () => {
    const filePath = "src/users.ts";
    const candidate = { ...candidateFor(smelly, filePath, "loadUser"), kind: "change" as const };
    expect(buildRareCaseFirstEvidence(candidate, project(smelly, filePath))).toBeUndefined();
  });
});
