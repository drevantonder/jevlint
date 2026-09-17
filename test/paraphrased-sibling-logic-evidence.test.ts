import { describe, expect, it } from "vitest";
import { extractCandidates } from "../src/candidates.js";
import { buildDuplicatedLogicEvidence } from "../src/evidence/duplicated-logic.js";
import { buildParaphrasedSiblingLogicEvidence } from "../src/evidence/paraphrased-sibling-logic.js";
import type { ProjectFile } from "../src/types.js";

function project(): ProjectFile[] {
  return [
    {
      filePath: "src/names.ts",
      source: "export interface Customer {\n"
        + "  given: string;\n"
        + "  family: string;\n"
        + "  handle: string;\n"
        + "}\n"
        + "export function displayName(user: Customer): string {\n"
        + "  if (user.handle.length > 0) return user.handle;\n"
        + "  return user.given + \" \" + user.family;\n"
        + "}\n",
    },
    {
      filePath: "src/labels.ts",
      source: "import type { Customer } from \"./names.js\";\n"
        + "export function formatUserLabel(account: Customer): string {\n"
        + "  const { handle, given, family } = account;\n"
        + "  if (handle) return handle;\n"
        + "  return `${given} ${family}`;\n"
        + "}\n",
    },
  ];
}

function candidateFor(projectFiles: ProjectFile[]) {
  const owner = projectFiles.find(({ filePath }) => filePath === "src/labels.ts");
  expect(owner).toBeDefined();
  if (!owner) throw new Error("Fixture has no labels file.");
  const candidate = extractCandidates(owner.filePath, owner.source)
    .filter(({ kind }) => kind === "function")
    .find(({ source }) => source.includes("formatUserLabel"));
  expect(candidate).toBeDefined();
  if (!candidate) throw new Error("Fixture has no candidate.");
  return candidate;
}

describe("paraphrased sibling logic evidence", () => {
  it("reports equivalent input and output shapes with dissimilar wording", () => {
    const projectFiles = project();
    const candidate = candidateFor(projectFiles);

    const evidence = buildParaphrasedSiblingLogicEvidence(candidate, projectFiles);

    expect(evidence).toMatchObject({
      signature: { parameterCount: 1, returnType: "string" },
      matches: [expect.objectContaining({
        functionName: "displayName",
        dissimilarity: expect.any(Number),
      })],
    });
    expect(evidence?.matches[0]?.dissimilarity).toBeGreaterThanOrEqual(0.5);
  });

  it("stays invisible to whole-body fingerprint matching", () => {
    const projectFiles = project();
    const candidate = candidateFor(projectFiles);

    expect(buildDuplicatedLogicEvidence(candidate, projectFiles)).toBeUndefined();
    expect(buildParaphrasedSiblingLogicEvidence(candidate, projectFiles)).toBeDefined();
  });

  it("abstains when no sibling shares the signature", () => {
    const projectFiles: ProjectFile[] = [{
      filePath: "src/labels.ts",
      source: "import type { User } from \"./names.js\";\n"
        + "export function formatUserLabel(account: User): string {\n"
        + "  return account.firstName;\n"
        + "}\n",
    }];
    const candidate = candidateFor(projectFiles);

    expect(buildParaphrasedSiblingLogicEvidence(candidate, projectFiles)).toBeUndefined();
  });
});
