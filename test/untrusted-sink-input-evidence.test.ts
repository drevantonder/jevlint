import { describe, expect, it } from "vitest";
import { extractCandidates } from "../src/candidates.js";
import { buildUntrustedSinkInputEvidence } from "../src/evidence/untrusted-sink-input.js";
import type { ProjectFile } from "../src/types.js";

function project(ownerSource: string) {
  const projectFiles: ProjectFile[] = [{ filePath: "src/users.ts", source: ownerSource }];
  const candidate = extractCandidates("src/users.ts", ownerSource)
    .filter(({ kind }) => kind === "function")
    .find(({ source }) => source.includes("query") || source.includes("findUser") || source.includes("countAll"));
  expect(candidate).toBeDefined();
  if (!candidate) throw new Error("Fixture has no sink candidate.");
  return { candidate, projectFiles };
}

describe("untrusted sink input evidence", () => {
  it("traces one hop from a query sink to a handler parameter", () => {
    const { candidate, projectFiles } = project(
      "import { db } from \"./db.js\";\n"
      + "export function findUser(userId: string): unknown {\n"
      + "  return db.query(`SELECT * FROM users WHERE id = ${userId}`);\n"
      + "}\n",
    );

    const evidence = buildUntrustedSinkInputEvidence(candidate, projectFiles);

    expect(evidence).toMatchObject({
      function: { name: "findUser" },
      sinks: [
        expect.objectContaining({
          sink: "query",
          hasPlaceholders: false,
          shellEnabled: false,
          sources: [expect.objectContaining({ kind: "parameter" })],
        }),
      ],
      escapeHelpers: [],
    });
  });

  it("abstains when interpolations resolve to module constants", () => {
    const { candidate, projectFiles } = project(
      "import { db } from \"./db.js\";\n"
      + "const TABLE = \"users\";\n"
      + "export function countAll(): unknown {\n"
      + "  return db.query(`SELECT COUNT(*) FROM ${TABLE}`);\n"
      + "}\n",
    );

    expect(buildUntrustedSinkInputEvidence(candidate, projectFiles)).toBeUndefined();
  });

  it("abstains when the sink is parameterized", () => {
    const { candidate, projectFiles } = project(
      "import { db } from \"./db.js\";\n"
      + "export function findUser(userId: string): unknown {\n"
      + "  return db.query(\"SELECT * FROM users WHERE id = $1\", [userId]);\n"
      + "}\n",
    );

    expect(buildUntrustedSinkInputEvidence(candidate, projectFiles)).toBeUndefined();
  });
});
