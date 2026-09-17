import { describe, expect, it } from "vitest";
import { extractCandidates } from "../src/candidates.js";
import { buildPredictableTokenEvidence } from "../src/evidence/predictable-token.js";
import type { ProjectFile } from "../src/types.js";

function files(ownerSource: string, extra: ProjectFile[] = []): ProjectFile[] {
  return [{ filePath: "src/auth.ts", source: ownerSource }, ...extra];
}

function changedFunction(ownerSource: string, extra: ProjectFile[] = []) {
  const projectFiles = files(ownerSource, extra);
  const candidate = extractCandidates("src/auth.ts", ownerSource)
    .find(({ kind }) => kind === "function");
  expect(candidate).toBeDefined();
  if (!candidate) throw new Error("Fixture has no function candidate.");
  return { candidate, projectFiles };
}

describe("predictable token evidence", () => {
  it("reports token assembly feeding a credential sink", () => {
    const { candidate, projectFiles } = changedFunction(
      "let resetToken = \"\";\n"
      + "export function mintResetToken(): string {\n"
      + "  const token = Math.random().toString(36).slice(2);\n"
      + "  resetToken = token;\n"
      + "  return token;\n"
      + "}\n",
    );

    const evidence = buildPredictableTokenEvidence(candidate, projectFiles);

    expect(evidence).toMatchObject({
      function: { name: "mintResetToken", exported: true },
      randomCalls: [{ call: "Math.random()", inTokenAssembly: true }],
      tokenAssembly: { present: true },
      secureAlternativeInScope: false,
      credentialSinks: [
        { kind: "assignment" },
        { kind: "return" },
      ],
    });
  });

  it("notes a secure alternative already in reach", () => {
    const { candidate, projectFiles } = changedFunction(
      "import { randomUUID } from \"node:crypto\";\n"
      + "export function sessionSuffix(): string {\n"
      + "  void randomUUID;\n"
      + "  return String(Math.random());\n"
      + "}\n",
    );

    expect(buildPredictableTokenEvidence(candidate, projectFiles)).toMatchObject({
      secureAlternativeInScope: true,
      credentialSinks: [],
    });
  });

  it("abstains when the function uses no weak randomness", () => {
    const { candidate, projectFiles } = changedFunction(
      "import { randomUUID } from \"node:crypto\";\n"
      + "export function mintSessionToken(): string {\n"
      + "  return randomUUID();\n"
      + "}\n",
    );

    expect(buildPredictableTokenEvidence(candidate, projectFiles)).toBeUndefined();
  });
});
