import { describe, expect, it } from "vitest";
import { extractCandidates } from "../src/candidates.js";
import { buildHandRolledSetOpsEvidence } from "../src/evidence/hand-rolled-set-ops.js";
import type { ProjectFile } from "../src/types.js";

function project(ownerSource: string, filePath = "src/tags.ts") {
  const projectFiles: ProjectFile[] = [{ filePath, source: ownerSource }];
  const candidate = extractCandidates(filePath, ownerSource)
    .filter(({ kind }) => kind === "function")
    .at(-1);
  expect(candidate).toBeDefined();
  expect(candidate?.kind).toBe("function");
  if (!candidate) throw new Error("Fixture has no function candidate.");
  return { candidate, projectFiles };
}

describe("hand rolled set ops evidence", () => {
  it("reports primitive dedupe by identity", () => {
    const { candidate, projectFiles } = project(
      "export function uniqueTags(tags: string[]): string[] {\n"
      + "  const out: string[] = [];\n"
      + "  for (const tag of tags) {\n"
      + "    if (out.indexOf(tag) === -1) out.push(tag);\n"
      + "  }\n"
      + "  return out;\n"
      + "}\n",
    );

    const evidence = buildHandRolledSetOpsEvidence(candidate, projectFiles);

    expect(evidence).toMatchObject({
      function: { name: "uniqueTags" },
      operation: "dedupe",
      membershipChecks: expect.arrayContaining([expect.stringContaining("indexOf")]),
      comparatorSignals: [],
    });
  });

  it("reports paired-loop intersection and domain comparators", () => {
    const { candidate, projectFiles } = project(
      "export function commonMembers(left: User[], right: User[]): User[] {\n"
      + "  const out: User[] = [];\n"
      + "  for (const member of left) {\n"
      + "    for (const other of right) {\n"
      + "      if (member.id === other.id && !out.includes(member)) out.push(member);\n"
      + "    }\n"
      + "  }\n"
      + "  return out;\n"
      + "}\n",
    );

    const evidence = buildHandRolledSetOpsEvidence(candidate, projectFiles);

    expect(evidence).toMatchObject({
      operation: "intersection",
      comparatorSignals: expect.arrayContaining([expect.stringContaining("id")]),
    });
  });

  it("abstains for a filter without a membership check", () => {
    const source = "export function adults(users: User[]): User[] {\n"
      + "  const out: User[] = [];\n"
      + "  for (const user of users) {\n"
      + "    if (user.age >= 18) out.push(user);\n"
      + "  }\n"
      + "  return out;\n"
      + "}\n";
    const { candidate, projectFiles } = project(source);

    expect(buildHandRolledSetOpsEvidence(candidate, projectFiles)).toBeUndefined();
  });
});
