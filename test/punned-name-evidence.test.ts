import { describe, expect, it } from "vitest";
import { extractCandidates } from "../src/candidates.js";
import { buildPunnedNameEvidence } from "../src/evidence/punned-name.js";
import type { Candidate, ProjectFile } from "../src/types.js";

const ARITHMETIC = "export function add(a: number, b: number): number {\n"
  + "  return a + b;\n"
  + "}\n";
const SET_INSERT = "export function add(item: string): void {\n"
  + "  members.add(item);\n"
  + "}\n";

function candidateFor(filePath: string, source: string, snippet: string): Candidate {
  const candidate = extractCandidates(filePath, source)
    .filter(({ kind }) => kind === "function")
    .find(({ source: text }) => text.includes(snippet));
  expect(candidate).toBeDefined();
  if (!candidate) throw new Error("Fixture has no candidate.");
  return candidate;
}

describe("punned name evidence", () => {
  it("connects same-name declarations with divergent shapes", () => {
    const projectFiles: ProjectFile[] = [
      { filePath: "src/math.ts", source: ARITHMETIC },
      { filePath: "src/members.ts", source: `const members = new Set<string>();\n${SET_INSERT}` },
    ];

    const evidence = buildPunnedNameEvidence(
      candidateFor("src/math.ts", ARITHMETIC, "return a + b"),
      projectFiles,
    );

    expect(evidence).toMatchObject({
      function: { name: "add" },
      signature: { parameterCount: 2, returnType: "number" },
      siblings: [
        expect.objectContaining({
          filePath: "src/members.ts",
          parameterCount: 1,
          returnType: "void",
        }),
      ],
    });
  });

  it("abstains when the name has one shape", () => {
    const projectFiles: ProjectFile[] = [{ filePath: "src/math.ts", source: ARITHMETIC }];

    expect(buildPunnedNameEvidence(
      candidateFor("src/math.ts", ARITHMETIC, "return a + b"),
      projectFiles,
    )).toBeUndefined();
  });

  it("abstains when siblings share the same shape", () => {
    const twin = "export function add(a: number, b: number): number {\n"
      + "  return a + b + 0;\n"
      + "}\n";
    const projectFiles: ProjectFile[] = [
      { filePath: "src/math.ts", source: ARITHMETIC },
      { filePath: "src/extra.ts", source: twin },
    ];

    expect(buildPunnedNameEvidence(
      candidateFor("src/math.ts", ARITHMETIC, "return a + b"),
      projectFiles,
    )).toBeUndefined();
  });
});
