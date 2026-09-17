import { describe, expect, it } from "vitest";
import { extractCandidates } from "../src/candidates.js";
import { buildNegativeBooleanNameEvidence } from "../src/evidence/negative-boolean-name.js";
import type { Candidate, ProjectFile } from "../src/types.js";

const SMELLY = "export function visibleItems(isNotReady: boolean, items: string[]): string[] {\n"
  + "  if (!isNotReady) {\n"
  + "    return items;\n"
  + "  }\n"
  + "  return [];\n"
  + "}\n";

function candidateFor(filePath: string, source: string, snippet: string): Candidate {
  const candidate = extractCandidates(filePath, source)
    .filter(({ kind }) => kind === "function")
    .find(({ source: text }) => text.includes(snippet));
  expect(candidate).toBeDefined();
  if (!candidate) throw new Error("Fixture has no candidate.");
  return candidate;
}

describe("negative boolean name evidence", () => {
  it("pairs a negated boolean name with its double-negative read", () => {
    const projectFiles: ProjectFile[] = [{ filePath: "src/list.ts", source: SMELLY }];

    const evidence = buildNegativeBooleanNameEvidence(
      candidateFor("src/list.ts", SMELLY, "visibleItems"),
      projectFiles,
    );

    expect(evidence).toMatchObject({
      function: { name: "visibleItems" },
      booleans: [expect.objectContaining({ name: "isNotReady", kind: "parameter" })],
      negatedReads: [expect.objectContaining({ expression: "!isNotReady" })],
    });
  });

  it("abstains for positive-form boolean names", () => {
    const source = "export function visibleItems(isReady: boolean, items: string[]): string[] {\n"
      + "  if (!isReady) {\n"
      + "    return [];\n"
      + "  }\n"
      + "  return items;\n"
      + "}\n";
    const projectFiles: ProjectFile[] = [{ filePath: "src/list.ts", source }];

    expect(buildNegativeBooleanNameEvidence(
      candidateFor("src/list.ts", source, "visibleItems"),
      projectFiles,
    )).toBeUndefined();
  });

  it("abstains when a negative-looking name is not boolean", () => {
    const source = "export function notifyUser(notification: string): void {\n"
      + "  console.log(notification);\n"
      + "}\n";
    const projectFiles: ProjectFile[] = [{ filePath: "src/list.ts", source }];

    expect(buildNegativeBooleanNameEvidence(
      candidateFor("src/list.ts", source, "notifyUser"),
      projectFiles,
    )).toBeUndefined();
  });
});
