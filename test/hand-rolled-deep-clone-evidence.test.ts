import { describe, expect, it } from "vitest";
import { extractCandidates } from "../src/candidates.js";
import { buildHandRolledDeepCloneEvidence } from "../src/evidence/hand-rolled-deep-clone.js";
import type { ProjectFile } from "../src/types.js";

function project(ownerSource: string, filePath = "src/state.ts", functionMarker = "function ") {
  const projectFiles: ProjectFile[] = [{ filePath, source: ownerSource }];
  const candidate = extractCandidates(filePath, ownerSource)
    .filter(({ kind }) => kind === "function")
    .find(({ source }) => source.includes(functionMarker));
  expect(candidate).toBeDefined();
  expect(candidate?.kind).toBe("function");
  if (!candidate) throw new Error("Fixture has no function candidate.");
  return { candidate, projectFiles };
}

describe("hand rolled deep clone evidence", () => {
  it("reports a JSON round-trip copy", () => {
    const { candidate, projectFiles } = project(
      "export function cloneState(state: AppState): AppState {\n"
      + "  return JSON.parse(JSON.stringify(state));\n"
      + "}\n",
    );

    const evidence = buildHandRolledDeepCloneEvidence(candidate, projectFiles);

    expect(evidence).toMatchObject({
      function: { name: "cloneState" },
      jsonRoundTrip: expect.stringContaining("JSON.parse"),
      recursiveClone: false,
    });
  });

  it("reports a recursive clone branching on built-in types", () => {
    const { candidate, projectFiles } = project(
      "export function deepClone(value: unknown): unknown {\n"
      + "  if (value instanceof Date) return new Date(value.getTime());\n"
      + "  if (value instanceof Map) return new Map([...value].map(([k, v]) => [k, deepClone(v)]));\n"
      + "  if (Array.isArray(value)) return value.map(deepClone);\n"
      + "  if (typeof value === \"object\" && value !== null) {\n"
      + "    return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, deepClone(v)]));\n"
      + "  }\n"
      + "  return value;\n"
      + "}\n",
    );

    const evidence = buildHandRolledDeepCloneEvidence(candidate, projectFiles);

    expect(evidence).toMatchObject({
      function: { name: "deepClone" },
      jsonRoundTrip: null,
      recursiveClone: true,
      typeBranches: expect.arrayContaining([expect.stringContaining("instanceof")]),
    });
  });

  it("carries prototype preservation as justification", () => {
    const { candidate, projectFiles } = project(
      "export function cloneEntity(entity: Entity): Entity {\n"
      + "  if (entity instanceof Model) {\n"
      + "    const copy = Object.create(Object.getPrototypeOf(entity));\n"
      + "    return Object.assign(copy, cloneEntity(entity.child));\n"
      + "  }\n"
      + "  if (Array.isArray(entity)) return entity.map(cloneEntity);\n"
      + "  return entity;\n"
      + "}\n",
    );

    const evidence = buildHandRolledDeepCloneEvidence(candidate, projectFiles);

    expect(evidence).toMatchObject({
      justification: { preservesPrototypeOrClass: true },
    });
  });

  it("abstains for a plain serializer without a copy shape", () => {
    const source = "export function serialize(state: AppState): string {\n"
      + "  return JSON.stringify(state);\n"
      + "}\n";
    const { candidate, projectFiles } = project(source);

    expect(buildHandRolledDeepCloneEvidence(candidate, projectFiles)).toBeUndefined();
  });
});
