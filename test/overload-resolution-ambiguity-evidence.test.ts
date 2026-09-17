import { describe, expect, it } from "vitest";
import { extractCandidates } from "../src/candidates.js";
import { buildOverloadResolutionAmbiguityEvidence } from "../src/evidence/overload-resolution-ambiguity.js";
import type { ProjectFile } from "../src/types.js";

const smelly = `export function search(query: string): string[];
export function search(query: string | RegExp): string[];
export function search(query: string | RegExp): string[] {
  return [String(query)];
}
`;

const smellyCaller = `import { search } from "./search.js";
export function run(query: string) {
  return search(query);
}
`;

const separated = `export function get(id: string): string;
export function get(id: string, fallback: string): string;
export function get(id: string, fallback = "none") {
  return id + fallback;
}
`;

const single = `export function total(values: number[]) {
  return values.reduce((left, right) => left + right, 0);
}
`;

function project(source: string, filePath = "src/search.ts", extra: ProjectFile[] = []) {
  return { files: [{ filePath, source }, ...extra], filePath };
}

function candidateFor(source: string, filePath: string, marker: string) {
  const candidate = extractCandidates(filePath, source)
    .find(({ kind, source: text }) => kind === "function" && text.includes(marker));
  expect(candidate).toBeDefined();
  return candidate!;
}

describe("overload resolution ambiguity evidence", () => {
  it("captures overlapping overloads with a caller matching both", () => {
    const { files, filePath } = project(smelly, "src/search.ts", [
      { filePath: "src/run.ts", source: smellyCaller },
    ]);
    const evidence = buildOverloadResolutionAmbiguityEvidence(
      candidateFor(smelly, filePath, "string | RegExp): string[] {"),
      files,
    );

    expect(evidence).toMatchObject({
      function: { name: "search", exported: true },
    });
    expect(evidence?.overloads).toHaveLength(2);
    expect(evidence?.ambiguousPairs).toHaveLength(1);
    expect(evidence?.ambiguousPairs[0]).toMatchObject({
      sameArity: true,
      overlappingParameters: [0],
    });
    expect(evidence?.callSummary.matchingMultipleOverloads).toBeGreaterThanOrEqual(1);
  });

  it("reports arity-separated overloads with no ambiguous pairs", () => {
    const { files, filePath } = project(separated);
    const evidence = buildOverloadResolutionAmbiguityEvidence(
      candidateFor(separated, filePath, 'fallback = "none"'),
      files,
    );

    expect(evidence?.overloads).toHaveLength(2);
    expect(evidence?.ambiguousPairs).toHaveLength(0);
    expect(evidence?.callSummary.matchingMultipleOverloads).toBe(0);
  });

  it("abstains when the function has fewer than two overloads", () => {
    const { files, filePath } = project(single);
    expect(buildOverloadResolutionAmbiguityEvidence(
      candidateFor(single, filePath, "total"),
      files,
    )).toBeUndefined();
  });
});
