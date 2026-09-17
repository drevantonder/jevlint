import { describe, expect, it } from "vitest";
import { extractCandidates } from "../src/candidates.js";
import { buildRuleEvidence } from "../src/evidence/index.js";
import { buildNonExhaustiveDomainHandlingEvidence } from "../src/evidence/non-exhaustive-domain-handling.js";
import type { ProjectFile } from "../src/types.js";

function project(ownerSource: string, name: string) {
  const projectFiles: ProjectFile[] = [{ filePath: "src/order.ts", source: ownerSource }];
  const candidate = extractCandidates("src/order.ts", ownerSource)
    .filter(({ kind }) => kind === "function")
    .find(({ source }) => source.includes(name));
  expect(candidate).toBeDefined();
  if (!candidate) throw new Error("Fixture has no function candidate.");
  return { candidate, projectFiles };
}

const UNION_SMELLY = "export type Status = \"paid\" | \"shipped\" | \"refunded\";\n"
  + "export function price(status: Status): number {\n"
  + "  switch (status) {\n"
  + "    case \"paid\":\n"
  + "      return 100;\n"
  + "    case \"shipped\":\n"
  + "      return 50;\n"
  + "  }\n"
  + "}\n";

describe("non-exhaustive domain handling evidence", () => {
  it("reports missing union members for a switch without a default", () => {
    const { candidate, projectFiles } = project(UNION_SMELLY, "price");

    const evidence = buildNonExhaustiveDomainHandlingEvidence(candidate, projectFiles);

    expect(evidence?.handling).toMatchObject({
      kind: "switch",
      discriminant: "status",
      hasDefaultOrElse: false,
      exhaustivenessAnchor: false,
    });
    expect(evidence?.handling.handledCases).toEqual(["paid", "shipped"]);
    expect(evidence?.domain).toMatchObject({ name: "Status", kind: "literal-union" });
    expect(evidence?.domain.members).toEqual(["paid", "shipped", "refunded"]);
    expect(evidence?.missingCases).toEqual(["refunded"]);
    expect(evidence?.handling.fallthrough).toBe("falls-off-end");
  });

  it("reports missing members for an if-chain without a terminal else", () => {
    const { candidate, projectFiles } = project(
      "export type Status = \"paid\" | \"shipped\" | \"refunded\";\n"
      + "export function label(status: Status): string {\n"
      + "  if (status === \"paid\") {\n"
      + "    return \"P\";\n"
      + "  } else if (status === \"shipped\") {\n"
      + "    return \"S\";\n"
      + "  }\n"
      + "  return \"?\";\n"
      + "}\n",
      "label",
    );

    const evidence = buildNonExhaustiveDomainHandlingEvidence(candidate, projectFiles);

    expect(evidence?.handling.kind).toBe("if-chain");
    expect(evidence?.missingCases).toEqual(["refunded"]);
  });

  it("resolves discriminated-union members through the discriminant property", () => {
    const { candidate, projectFiles } = project(
      "export type Shape = { kind: \"circle\"; radius: number } | { kind: \"square\"; side: number } | { kind: \"triangle\"; base: number };\n"
      + "export function sides(shape: Shape): number {\n"
      + "  switch (shape.kind) {\n"
      + "    case \"circle\":\n"
      + "      return 1;\n"
      + "    case \"square\":\n"
      + "      return 4;\n"
      + "  }\n"
      + "}\n",
      "sides",
    );

    const evidence = buildNonExhaustiveDomainHandlingEvidence(candidate, projectFiles);

    expect(evidence?.domain).toMatchObject({ name: "Shape", kind: "discriminated-union" });
    expect(evidence?.missingCases).toEqual(["triangle"]);
  });

  it("resolves enum members against the handled cases", () => {
    const { candidate, projectFiles } = project(
      "export enum Role { Admin, Editor, Viewer }\n"
      + "export function portal(role: Role): string {\n"
      + "  switch (role) {\n"
      + "    case Role.Admin:\n"
      + "      return \"a\";\n"
      + "    case Role.Editor:\n"
      + "      return \"e\";\n"
      + "  }\n"
      + "}\n",
      "portal",
    );

    const evidence = buildNonExhaustiveDomainHandlingEvidence(candidate, projectFiles);

    expect(evidence?.domain).toMatchObject({ name: "Role", kind: "enum" });
    expect(evidence?.missingCases).toEqual(["Viewer"]);
  });

  it("abstains when a default, anchor, or full coverage removes the gap", () => {
    const withDefault = project(
      "export type Status = \"paid\" | \"shipped\" | \"refunded\";\n"
      + "export function price(status: Status): number {\n"
      + "  switch (status) {\n"
      + "    case \"paid\":\n"
      + "      return 100;\n"
      + "    case \"shipped\":\n"
      + "      return 50;\n"
      + "    default:\n"
      + "      return 0;\n"
      + "  }\n"
      + "}\n",
      "price",
    );
    expect(
      buildNonExhaustiveDomainHandlingEvidence(withDefault.candidate, withDefault.projectFiles),
    ).toBeUndefined();

    const anchored = project(
      "export type Status = \"paid\" | \"shipped\" | \"refunded\";\n"
      + "export function price(status: Status): number {\n"
      + "  switch (status) {\n"
      + "    case \"paid\":\n"
      + "      return 100;\n"
      + "    case \"shipped\":\n"
      + "      return 50;\n"
      + "  }\n"
      + "  return assertNever(status);\n"
      + "}\n",
      "price",
    );
    expect(
      buildNonExhaustiveDomainHandlingEvidence(anchored.candidate, anchored.projectFiles),
    ).toBeUndefined();

    const exhaustive = project(
      "export type Status = \"paid\" | \"shipped\";\n"
      + "export function price(status: Status): number {\n"
      + "  switch (status) {\n"
      + "    case \"paid\":\n"
      + "      return 100;\n"
      + "    case \"shipped\":\n"
      + "      return 50;\n"
      + "  }\n"
      + "}\n",
      "price",
    );
    expect(
      buildNonExhaustiveDomainHandlingEvidence(exhaustive.candidate, exhaustive.projectFiles),
    ).toBeUndefined();
  });

  it("abstains without a declared finite domain", () => {
    const { candidate, projectFiles } = project(
      "export function label(mode: string): string {\n"
      + "  if (mode === \"fast\") return \"F\";\n"
      + "  if (mode === \"slow\") return \"S\";\n"
      + "  return \"?\";\n"
      + "}\n",
      "label",
    );

    expect(buildNonExhaustiveDomainHandlingEvidence(candidate, projectFiles)).toBeUndefined();
  });

  it("abstains for non-function candidates and dispatches the rule id", () => {
    const { candidate, projectFiles } = project(UNION_SMELLY, "price");
    expect(
      buildNonExhaustiveDomainHandlingEvidence({ ...candidate, kind: "comment" }, projectFiles),
    ).toBeUndefined();

    expect(
      buildRuleEvidence("jev/no-non-exhaustive-domain-handling", candidate, projectFiles),
    ).toMatchObject({ handled: true, evidence: expect.anything() });
  });
});
