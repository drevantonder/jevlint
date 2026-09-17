import { describe, expect, it } from "vitest";
import { extractCandidates } from "../src/candidates.js";
import { buildDeceptiveNameEvidence } from "../src/evidence/deceptive-name.js";
import type { Candidate, ProjectFile } from "../src/types.js";

const SMELLY = "export interface User {\n"
  + "  name: string;\n"
  + "}\n"
  + "export function firstUser(users: User, isReady: string): User {\n"
  + "  return users;\n"
  + "}\n";

function candidateFor(source: string, snippet: string): Candidate {
  const candidate = extractCandidates("src/users.ts", source)
    .filter(({ kind }) => kind === "function")
    .find(({ source: text }) => text.includes(snippet));
  expect(candidate).toBeDefined();
  if (!candidate) throw new Error("Fixture has no candidate.");
  return candidate;
}

describe("deceptive name evidence", () => {
  it("flags a plural name holding a singular and a predicate prefix on a non-boolean", () => {
    const projectFiles: ProjectFile[] = [{ filePath: "src/users.ts", source: SMELLY }];
    const evidence = buildDeceptiveNameEvidence(candidateFor(SMELLY, "firstUser"), projectFiles);

    expect(evidence).toMatchObject({
      function: { name: "firstUser" },
      findings: expect.arrayContaining([
        expect.objectContaining({ name: "users", asserted: "plural collection" }),
        expect.objectContaining({ name: "isReady", asserted: "boolean predicate" }),
      ]),
    });
  });

  it("flags a sorted claim with no establishing operation", () => {
    const source = "export function topScores(scores: number[]): number[] {\n"
      + "  const sortedTop = scores.slice(0, 3);\n"
      + "  return sortedTop;\n"
      + "}\n";
    const projectFiles: ProjectFile[] = [{ filePath: "src/scores.ts", source }];
    const candidate = extractCandidates("src/scores.ts", source)
      .filter(({ kind }) => kind === "function")
      .find(({ source: text }) => text.includes("topScores"));
    expect(candidate).toBeDefined();
    if (!candidate) return;

    expect(buildDeceptiveNameEvidence(candidate, projectFiles)).toMatchObject({
      findings: expect.arrayContaining([
        expect.objectContaining({ name: "sortedTop", asserted: "sorted" }),
      ]),
    });
  });

  it("abstains when names match their values", () => {
    const source = "export function firstUser(users: User[], isReady: boolean): User {\n"
      + "  if (!isReady) throw new Error(\"not ready\");\n"
      + "  return users[0];\n"
      + "}\n";
    const projectFiles: ProjectFile[] = [{ filePath: "src/users.ts", source }];

    expect(buildDeceptiveNameEvidence(candidateFor(source, "firstUser"), projectFiles))
      .toBeUndefined();
  });

  it("abstains for a non-function candidate", () => {
    const source = "export interface User {\n"
      + "  name: string;\n"
      + "}\n";
    const candidate = extractCandidates("src/users.ts", source)[0];
    expect(candidate).toBeDefined();
    if (!candidate) return;

    expect(buildDeceptiveNameEvidence(candidate, [{ filePath: "src/users.ts", source }]))
      .toBeUndefined();
  });
});
