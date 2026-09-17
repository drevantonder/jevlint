import { describe, expect, it } from "vitest";
import { extractCandidates } from "../src/candidates.js";
import { buildDistrustfulTypeGuardEvidence } from "../src/evidence/distrustful-type-guard.js";
import { buildRuleEvidence } from "../src/evidence/index.js";
import type { ProjectFile } from "../src/types.js";

function project(ownerSource: string) {
  const projectFiles: ProjectFile[] = [{ filePath: "src/greet.ts", source: ownerSource }];
  const candidate = extractCandidates("src/greet.ts", ownerSource)
    .filter(({ kind }) => kind === "function")
    .find(({ source }) => source.includes("greet"));
  expect(candidate).toBeDefined();
  if (!candidate) throw new Error("Fixture has no greet candidate.");
  return { candidate, projectFiles };
}

describe("distrustful type guard evidence", () => {
  it("flags a typeof guard the string annotation already settles", () => {
    const { candidate, projectFiles } = project(
      "export function greet(name: string): string {\n"
      + "  if (typeof name !== \"string\") {\n"
      + "    throw new Error(\"bad name\");\n"
      + "  }\n"
      + "  return name;\n"
      + "}\n",
    );

    const evidence = buildDistrustfulTypeGuardEvidence(candidate, projectFiles);

    expect(evidence?.guards).toMatchObject([
      { guarded: "name", declaredType: "string", kind: "typeof-check" },
    ]);
  });

  it("flags a null check against a non-nullable annotation", () => {
    const { candidate, projectFiles } = project(
      "export function greet(name: string): string {\n"
      + "  if (name == null) {\n"
      + "    return \"anon\";\n"
      + "  }\n"
      + "  return name;\n"
      + "}\n",
    );

    const evidence = buildDistrustfulTypeGuardEvidence(candidate, projectFiles);

    expect(evidence?.guards).toMatchObject([{ guarded: "name", kind: "null-check" }]);
  });

  it("abstains on nullable, untyped, and boundary-crossing inputs", () => {
    const nullable = project(
      "export function greet(name: string | null): string {\n"
      + "  if (name == null) {\n"
      + "    return \"anon\";\n"
      + "  }\n"
      + "  return name;\n"
      + "}\n",
    );
    expect(buildDistrustfulTypeGuardEvidence(nullable.candidate, nullable.projectFiles)).toBeUndefined();

    const untyped = project(
      "export function greet(name: unknown): string {\n"
      + "  if (typeof name !== \"string\") {\n"
      + "    throw new Error(\"bad\");\n"
      + "  }\n"
      + "  return name;\n"
      + "}\n",
    );
    expect(buildDistrustfulTypeGuardEvidence(untyped.candidate, untyped.projectFiles)).toBeUndefined();

    const boundary = project(
      "export function greet(raw: string): string {\n"
      + "  const name = JSON.parse(raw) as string;\n"
      + "  if (typeof name !== \"string\") {\n"
      + "    throw new Error(\"bad\");\n"
      + "  }\n"
      + "  return name;\n"
      + "}\n",
    );
    expect(buildDistrustfulTypeGuardEvidence(boundary.candidate, boundary.projectFiles)).toBeUndefined();
  });

  it("abstains for non-function candidates and dispatches the rule id", () => {
    const { candidate, projectFiles } = project(
      "export function greet(name: string): string {\n"
      + "  if (typeof name !== \"string\") {\n"
      + "    throw new Error(\"bad\");\n"
      + "  }\n"
      + "  return name;\n"
      + "}\n",
    );
    expect(buildDistrustfulTypeGuardEvidence({ ...candidate, kind: "comment" }, projectFiles)).toBeUndefined();
    expect(buildRuleEvidence("jev/no-distrustful-type-guard", candidate, projectFiles)).toMatchObject({
      handled: true,
      evidence: expect.anything(),
    });
  });
});
