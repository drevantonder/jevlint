import { describe, expect, it } from "vitest";
import { extractCandidates } from "../src/candidates.js";
import { buildHandRolledGroupByEvidence } from "../src/evidence/hand-rolled-group-by.js";
import { buildDuplicatedLogicEvidence } from "../src/evidence/duplicated-logic.js";
import type { ProjectFile } from "../src/types.js";

function project(ownerSource: string, filePath = "src/orders.ts") {
  const projectFiles: ProjectFile[] = [{ filePath, source: ownerSource }];
  const candidate = extractCandidates(filePath, ownerSource)
    .filter(({ kind }) => kind === "function")
    .at(-1);
  expect(candidate).toBeDefined();
  expect(candidate?.kind).toBe("function");
  if (!candidate) throw new Error("Fixture has no function candidate.");
  return { candidate, projectFiles };
}

const GROUP_BY = "export function groupByStatus(orders: Order[]): Record<string, Order[]> {\n"
  + "  const groups: Record<string, Order[]> = {};\n"
  + "  for (const order of orders) {\n"
  + "    const key = order.status;\n"
  + "    groups[key] ??= [];\n"
  + "    groups[key].push(order);\n"
  + "  }\n"
  + "  return groups;\n"
  + "}\n";

describe("hand rolled group by evidence", () => {
  it("reports a loop with key-indexed accumulator writes", () => {
    const { candidate, projectFiles } = project(GROUP_BY);

    const evidence = buildHandRolledGroupByEvidence(candidate, projectFiles);

    expect(evidence).toMatchObject({
      function: { name: "groupByStatus" },
      groupingLoop: expect.stringContaining("for"),
      accumulatorWrites: expect.arrayContaining([expect.stringContaining("push")]),
      keyNormalization: [],
      justification: { usesMapWithIdentity: false, compositeKey: false },
    });
  });

  it("carries the justification side for Map identity grouping", () => {
    const { candidate, projectFiles } = project(
      "export function groupByOwner(pets: Pet[]): Map<Owner, Pet[]> {\n"
      + "  const groups = new Map<Owner, Pet[]>();\n"
      + "  for (const pet of pets) {\n"
      + "    const list = groups.get(pet.owner) ?? [];\n"
      + "    list.push(pet);\n"
      + "    groups.set(pet.owner, list);\n"
      + "  }\n"
      + "  return groups;\n"
      + "}\n",
    );

    const evidence = buildHandRolledGroupByEvidence(candidate, projectFiles);

    expect(evidence).toMatchObject({
      justification: { usesMapWithIdentity: true },
    });
  });

  it("fires where no-duplicated-logic abstains without a repository match", () => {
    const { candidate, projectFiles } = project(GROUP_BY);

    expect(buildHandRolledGroupByEvidence(candidate, projectFiles)).toBeDefined();
    expect(buildDuplicatedLogicEvidence(candidate, projectFiles)).toBeUndefined();
  });

  it("abstains for a plain transformation loop", () => {
    const source = "export function doubleAll(values: number[]): number[] {\n"
      + "  const out: number[] = [];\n"
      + "  for (const value of values) {\n"
      + "    out.push(value * 2);\n"
      + "  }\n"
      + "  return out;\n"
      + "}\n";
    const { candidate, projectFiles } = project(source);

    expect(buildHandRolledGroupByEvidence(candidate, projectFiles)).toBeUndefined();
  });

  it("abstains for non-function candidates", () => {
    const { candidate, projectFiles } = project(GROUP_BY);

    expect(buildHandRolledGroupByEvidence({ ...candidate, kind: "comment" }, projectFiles))
      .toBeUndefined();
  });
});
