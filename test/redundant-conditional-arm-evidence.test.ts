import { describe, expect, it } from "vitest";
import { extractCandidates } from "../src/candidates.js";
import { buildRuleEvidence } from "../src/evidence/index.js";
import { buildRedundantConditionalArmEvidence } from "../src/evidence/redundant-conditional-arm.js";
import type { ProjectFile } from "../src/types.js";

function project(ownerSource: string) {
  const projectFiles: ProjectFile[] = [{ filePath: "src/route.ts", source: ownerSource }];
  const candidate = extractCandidates("src/route.ts", ownerSource)
    .filter(({ kind }) => kind === "function")
    .find(({ source }) => source.includes("route"));
  expect(candidate).toBeDefined();
  if (!candidate) throw new Error("Fixture has no route candidate.");
  return { candidate, projectFiles };
}

describe("redundant conditional arm evidence", () => {
  it("groups arms with byte-identical bodies including the default", () => {
    const { candidate, projectFiles } = project(
      "export function route(kind: string): string {\n"
      + "  switch (kind) {\n"
      + "    case \"a\":\n"
      + "      return \"x\";\n"
      + "    case \"b\":\n"
      + "      return \"x\";\n"
      + "    default:\n"
      + "      return \"x\";\n"
      + "  }\n"
      + "}\n",
    );

    const evidence = buildRedundantConditionalArmEvidence(candidate, projectFiles);

    expect(evidence?.conditionals).toHaveLength(1);
    expect(evidence?.conditionals[0]).toMatchObject({ kind: "switch", discriminant: "kind" });
    expect(evidence?.conditionals[0]?.bodyGroups).toEqual([[0, 1, 2]]);
  });

  it("flags an else-if arm whose body repeats the earlier arm", () => {
    const { candidate, projectFiles } = project(
      "export function route(x: number): number {\n"
      + "  if (x > 0) {\n"
      + "    return 1;\n"
      + "  } else if (x >= 0) {\n"
      + "    return 1;\n"
      + "  } else {\n"
      + "    return 2;\n"
      + "  }\n"
      + "}\n",
    );

    const evidence = buildRedundantConditionalArmEvidence(candidate, projectFiles);

    expect(evidence?.conditionals).toHaveLength(1);
    expect(evidence?.conditionals[0]?.bodyGroups).toEqual([[0, 1]]);
  });

  it("marks opaque predicate tests without claiming subsumption", () => {
    const { candidate, projectFiles } = project(
      "export function route(x: number): number {\n"
      + "  if (isSpecial(x)) {\n"
      + "    return 1;\n"
      + "  } else if (x > 0) {\n"
      + "    return 2;\n"
      + "  } else {\n"
      + "    return 3;\n"
      + "  }\n"
      + "}\n",
    );

    const evidence = buildRedundantConditionalArmEvidence(candidate, projectFiles);

    expect(evidence?.opaqueTests).toEqual(["isSpecial(x)"]);
    expect(evidence?.conditionals[0]?.bodyGroups).toEqual([]);
  });

  it("abstains on lone guard clauses and conditional-free bodies", () => {
    const guarded = project(
      "export function route(x: number): number {\n"
      + "  if (x < 0) {\n"
      + "    return 0;\n"
      + "  }\n"
      + "  return x;\n"
      + "}\n",
    );
    expect(buildRedundantConditionalArmEvidence(guarded.candidate, guarded.projectFiles)).toBeUndefined();

    const plain = project("export function route(x: number): number {\n  return x;\n}\n");
    expect(buildRedundantConditionalArmEvidence(plain.candidate, plain.projectFiles)).toBeUndefined();
  });

  it("abstains for non-function candidates and dispatches the rule id", () => {
    const { candidate, projectFiles } = project("export function route(x: number): number {\n  return x;\n}\n");
    expect(
      buildRedundantConditionalArmEvidence({ ...candidate, kind: "comment" }, projectFiles),
    ).toBeUndefined();

    const smelly = project(
      "export function route(kind: string): string {\n"
      + "  switch (kind) {\n"
      + "    case \"a\":\n"
      + "      return \"x\";\n"
      + "    default:\n"
      + "      return \"x\";\n"
      + "  }\n"
      + "}\n",
    );
    expect(
      buildRuleEvidence("jev/no-redundant-conditional-arm", smelly.candidate, smelly.projectFiles),
    ).toMatchObject({ handled: true, evidence: expect.anything() });
  });
});
