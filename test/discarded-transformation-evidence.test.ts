import { describe, expect, it } from "vitest";
import { extractCandidates } from "../src/candidates.js";
import { buildDiscardedTransformationEvidence } from "../src/evidence/discarded-transformation.js";
import type { ProjectFile } from "../src/types.js";

function project(ownerSource: string) {
  const projectFiles: ProjectFile[] = [{ filePath: "src/users.ts", source: ownerSource }];
  const candidate = extractCandidates("src/users.ts", ownerSource)
    .filter(({ kind }) => kind === "function")
    .find(({ source }) => source.includes(".map("));
  expect(candidate).toBeDefined();
  if (!candidate) throw new Error("Fixture has no map candidate.");
  return { candidate, projectFiles };
}

describe("discarded transformation evidence", () => {
  it("reports a pure mapper called as a bare statement", () => {
    const { candidate, projectFiles } = project(
      "export function pickNames(users: { name: string }[]): void {\n"
      + "  users.map((user) => user.name);\n"
      + "}\n",
    );

    const evidence = buildDiscardedTransformationEvidence(candidate, projectFiles);

    expect(evidence).toMatchObject({
      function: { name: "pickNames" },
      sites: [
        expect.objectContaining({
          method: "map",
          resultUse: "bare-statement",
          callback: expect.objectContaining({
            mutatesOuter: false,
            performsCall: false,
          }),
        }),
      ],
    });
  });

  it("marks a side-effecting callback misusing map as iteration", () => {
    const { candidate, projectFiles } = project(
      "import { save } from \"./store.js\";\n"
      + "export function persistAll(rows: string[]): void {\n"
      + "  rows.map((row) => save(row));\n"
      + "}\n",
    );

    expect(buildDiscardedTransformationEvidence(candidate, projectFiles)).toMatchObject({
      sites: [
        expect.objectContaining({
          callback: expect.objectContaining({ performsCall: true }),
        }),
      ],
    });
  });

  it("abstains when the transformation result is returned", () => {
    const { candidate, projectFiles } = project(
      "export function pickNames(users: { name: string }[]): string[] {\n"
      + "  return users.map((user) => user.name);\n"
      + "}\n",
    );

    expect(buildDiscardedTransformationEvidence(candidate, projectFiles)).toBeUndefined();
  });
});
