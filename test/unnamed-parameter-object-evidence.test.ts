import { describe, expect, it } from "vitest";
import { extractCandidates } from "../src/candidates.js";
import { buildUnnamedParameterObjectEvidence } from "../src/evidence/unnamed-parameter-object.js";
import type { ProjectFile } from "../src/types.js";

function files(ownerSource: string, extra: ProjectFile[] = []): ProjectFile[] {
  return [{ filePath: "src/users.ts", source: ownerSource }, ...extra];
}

function changedFunction(ownerSource: string, extra: ProjectFile[] = []) {
  const projectFiles = files(ownerSource, extra);
  const candidate = extractCandidates("src/users.ts", ownerSource)
    .find(({ kind }) => kind === "function");
  expect(candidate).toBeDefined();
  if (!candidate) throw new Error("Fixture has no function candidate.");
  return { candidate, projectFiles };
}

describe("unnamed parameter object evidence", () => {
  it("reports shared affixes and callers spreading one object", () => {
    const { candidate, projectFiles } = changedFunction(
      "export function createUser(userName: string, userEmail: string, userRole: string): string {\n"
      + "  return [userName, userEmail, userRole].join(\":\");\n"
      + "}\n",
      [{
        filePath: "src/signup.ts",
        source: "import { createUser } from \"./users.js\";\n"
          + "export function signup(form: { name: string; email: string; role: string }): string {\n"
          + "  return createUser(form.name, form.email, form.role);\n"
          + "}\n",
      }],
    );

    const evidence = buildUnnamedParameterObjectEvidence(candidate, projectFiles);

    expect(evidence).toMatchObject({
      function: { name: "createUser", parameterCount: 3 },
      cohesion: {
        sharedAffixGroups: [
          { affix: "user", kind: "prefix" },
        ],
      },
      objectSpreadCalls: [
        { commonRoot: "form", memberArgumentCount: 3 },
      ],
    });
  });

  it("reports parameters packed into one object in the body", () => {
    const { candidate, projectFiles } = changedFunction(
      "export function openConnection(host: string, port: number, scheme: string): string {\n"
      + "  const address = { host, port, scheme };\n"
      + "  return JSON.stringify(address);\n"
      + "}\n",
    );

    expect(buildUnnamedParameterObjectEvidence(candidate, projectFiles)).toMatchObject({
      cohesion: { packsParametersIntoObject: true },
    });
  });

  it("reports sibling functions taking overlapping subsets", () => {
    const { candidate, projectFiles } = changedFunction(
      "export function renderUser(userName: string, userEmail: string, userRole: string): string {\n"
      + "  return userName + userEmail + userRole;\n"
      + "}\n"
      + "export function describeUser(userName: string, userEmail: string): string {\n"
      + "  return userName + userEmail;\n"
      + "}\n",
    );

    expect(buildUnnamedParameterObjectEvidence(candidate, projectFiles)).toMatchObject({
      siblingOverlap: [{ name: "describeUser" }],
    });
  });

  it("abstains when the function takes fewer than two parameters", () => {
    const { candidate, projectFiles } = changedFunction(
      "export function greet(name: string): string {\n"
      + "  return `hello ${name}`;\n"
      + "}\n",
    );

    expect(buildUnnamedParameterObjectEvidence(candidate, projectFiles)).toBeUndefined();
  });

  it("abstains for non-function candidates", () => {
    const source = "// just a comment\n";
    const projectFiles = files(source);
    const candidate = extractCandidates("src/users.ts", "export const x = 1;\n// note\n")
      .find(({ kind }) => kind === "comment");
    expect(candidate).toBeDefined();
    if (!candidate) throw new Error("Fixture has no comment candidate.");
    expect(buildUnnamedParameterObjectEvidence(candidate, projectFiles)).toBeUndefined();
  });
});
