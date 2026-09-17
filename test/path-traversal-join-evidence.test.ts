import { describe, expect, it } from "vitest";
import { extractCandidates } from "../src/candidates.js";
import { buildPathTraversalJoinEvidence } from "../src/evidence/path-traversal-join.js";
import type { ProjectFile } from "../src/types.js";

function project(ownerSource: string) {
  const projectFiles: ProjectFile[] = [{ filePath: "src/files.ts", source: ownerSource }];
  const candidate = extractCandidates("src/files.ts", ownerSource)
    .filter(({ kind }) => kind === "function")
    .find(({ source }) => source.includes("read"));
  expect(candidate).toBeDefined();
  if (!candidate) throw new Error("Fixture has no read candidate.");
  return { candidate, projectFiles };
}

const IMPORTS = "import path from \"path\";\nimport fs from \"node:fs\";\n";

describe("path traversal join evidence", () => {
  it("reports a param-derived segment in a path join", () => {
    const { candidate, projectFiles } = project(
      IMPORTS
      + "export function read(name: string) {\n"
      + "  return fs.readFile(path.join(\"/uploads\", name), \"utf8\");\n"
      + "}\n",
    );

    expect(buildPathTraversalJoinEvidence(candidate, projectFiles)).toMatchObject({
      function: { name: "read" },
      joins: [
        {
          kind: "fs-call",
          segment: "path.join(\"/uploads\", name)",
          paramDerived: true,
          hasConfinementGuard: false,
          importedFrom: "node:fs",
        },
        {
          kind: "path-join",
          segment: "name",
          paramDerived: true,
          hasConfinementGuard: false,
          importedFrom: "path",
        },
      ],
    });
  });

  it("notes basename confinement between the input and the join", () => {
    const { candidate, projectFiles } = project(
      IMPORTS
      + "export function read(name: string) {\n"
      + "  const clean = path.basename(name);\n"
      + "  return fs.readFile(path.join(\"/uploads\", name), clean);\n"
      + "}\n",
    );

    const evidence = buildPathTraversalJoinEvidence(candidate, projectFiles);

    expect(evidence?.joins.some(({ hasConfinementGuard }) => hasConfinementGuard)).toBe(true);
  });

  it("abstains for constant segments", () => {
    const { candidate, projectFiles } = project(
      IMPORTS
      + "export function read() {\n"
      + "  return fs.readFile(path.join(\"/uploads\", \"logo.png\"), \"utf8\");\n"
      + "}\n",
    );

    expect(buildPathTraversalJoinEvidence(candidate, projectFiles)).toBeUndefined();
  });

  it("abstains when there is no filesystem shape", () => {
    const { candidate, projectFiles } = project(
      "export function read(name: string) {\n"
      + "  return name.toUpperCase();\n"
      + "}\n",
    );

    expect(buildPathTraversalJoinEvidence(candidate, projectFiles)).toBeUndefined();
  });
});
