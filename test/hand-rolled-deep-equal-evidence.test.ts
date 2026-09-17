import { describe, expect, it } from "vitest";
import { extractCandidates } from "../src/candidates.js";
import { buildHandRolledDeepEqualEvidence } from "../src/evidence/hand-rolled-deep-equal.js";
import type { ProjectFile } from "../src/types.js";

function project(ownerSource: string, filePath = "src/compare.ts", extra: ProjectFile[] = []) {
  const projectFiles: ProjectFile[] = [{ filePath, source: ownerSource }, ...extra];
  const candidate = extractCandidates(filePath, ownerSource)
    .filter(({ kind }) => kind === "function")
    .find(({ source }) => source.includes("function "));
  expect(candidate).toBeDefined();
  expect(candidate?.kind).toBe("function");
  if (!candidate) throw new Error("Fixture has no function candidate.");
  return { candidate, projectFiles };
}

const DEEP_EQUAL = "export function deepEqual(left: unknown, right: unknown): boolean {\n"
  + "  if (left === right) return true;\n"
  + "  if (typeof left !== \"object\" || typeof right !== \"object\" || left === null || right === null) return false;\n"
  + "  if (Object.keys(left).length !== Object.keys(right).length) return false;\n"
  + "  return Object.keys(left).every((key) => deepEqual((left as any)[key], (right as any)[key]));\n"
  + "}\n";

describe("hand rolled deep equal evidence", () => {
  it("reports a recursive structural compare", () => {
    const { candidate, projectFiles } = project(DEEP_EQUAL);

    const evidence = buildHandRolledDeepEqualEvidence(candidate, projectFiles);

    expect(evidence).toMatchObject({
      function: { name: "deepEqual" },
      keyLengthCheck: true,
      recursiveCall: true,
      ownedCapability: { fileImportsAssertOrUtil: false, projectImportsDeepEqualDep: [] },
      justification: { domainComparator: false, zeroDepFootprint: true },
    });
  });

  it("records an owned dependency from project imports", () => {
    const { candidate, projectFiles } = project(
      DEEP_EQUAL,
      "src/compare.ts",
      [{ filePath: "src/other.ts", source: "import isEqual from \"fast-deep-equal\";\n" }],
    );

    const evidence = buildHandRolledDeepEqualEvidence(candidate, projectFiles);

    expect(evidence).toMatchObject({
      ownedCapability: { projectImportsDeepEqualDep: ["fast-deep-equal"] },
      justification: { zeroDepFootprint: false },
    });
  });

  it("records domain comparison semantics as justification", () => {
    const { candidate, projectFiles } = project(
      "export function deepEqual(left: any, right: any, epsilon = 1e-9): boolean {\n"
      + "  if (typeof left === \"number\" && typeof right === \"number\") return Math.abs(left - right) < epsilon;\n"
      + "  const leftKeys = Object.keys(left);\n"
      + "  if (leftKeys.length !== Object.keys(right).length) return false;\n"
      + "  return leftKeys.every((key) => deepEqual(left[key], right[key], epsilon));\n"
      + "}\n",
    );

    const evidence = buildHandRolledDeepEqualEvidence(candidate, projectFiles);

    expect(evidence).toMatchObject({
      justification: { domainComparator: true },
    });
  });

  it("abstains for a shallow field comparison", () => {
    const source = "export function sameId(left: User, right: User): boolean {\n"
      + "  return left.id === right.id;\n"
      + "}\n";
    const { candidate, projectFiles } = project(source);

    expect(buildHandRolledDeepEqualEvidence(candidate, projectFiles)).toBeUndefined();
  });
});
