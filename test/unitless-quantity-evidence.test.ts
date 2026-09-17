import { describe, expect, it } from "vitest";
import { extractCandidates } from "../src/candidates.js";
import { buildUnitlessQuantityEvidence } from "../src/evidence/unitless-quantity.js";
import type { Candidate, ProjectFile } from "../src/types.js";

const SMELLY = "export function scheduleRetry(timeout: number, task: () => void): void {\n"
  + "  setTimeout(task, timeout);\n"
  + "}\n";
const CALLERS = "import { scheduleRetry } from \"./retry.js\";\n"
  + "export function boot(run: () => void): void {\n"
  + "  scheduleRetry(500, run);\n"
  + "  scheduleRetry(30, run);\n"
  + "}\n";

function candidateFor(filePath: string, source: string, snippet: string): Candidate {
  const candidate = extractCandidates(filePath, source)
    .filter(({ kind }) => kind === "function")
    .find(({ source: text }) => text.includes(snippet));
  expect(candidate).toBeDefined();
  if (!candidate) throw new Error("Fixture has no candidate.");
  return candidate;
}

describe("unitless quantity evidence", () => {
  it("pairs a unitless timeout with its timer sink and caller scales", () => {
    const projectFiles: ProjectFile[] = [
      { filePath: "src/retry.ts", source: SMELLY },
      { filePath: "src/boot.ts", source: CALLERS },
    ];

    const evidence = buildUnitlessQuantityEvidence(
      candidateFor("src/retry.ts", SMELLY, "scheduleRetry"),
      projectFiles,
    );

    expect(evidence).toMatchObject({
      function: { name: "scheduleRetry" },
      quantities: [
        expect.objectContaining({
          name: "timeout",
          hasUnit: false,
          sinkCalls: expect.arrayContaining([expect.stringContaining("setTimeout")]),
        }),
      ],
      callerQuantities: expect.arrayContaining([
        expect.objectContaining({ argument: "500" }),
        expect.objectContaining({ argument: "30" }),
      ]),
    });
  });

  it("abstains when the unit is named", () => {
    const source = "export function scheduleRetry(timeoutMs: number, task: () => void): void {\n"
      + "  setTimeout(task, timeoutMs);\n"
      + "}\n";
    const projectFiles: ProjectFile[] = [{ filePath: "src/retry.ts", source }];

    expect(buildUnitlessQuantityEvidence(
      candidateFor("src/retry.ts", source, "scheduleRetry"),
      projectFiles,
    )).toBeUndefined();
  });

  it("abstains when a unitless number never reaches a scale-sensitive position", () => {
    const source = "export function totalCount(count: number): number {\n"
      + "  return count + 1;\n"
      + "}\n";
    const projectFiles: ProjectFile[] = [{ filePath: "src/count.ts", source }];

    expect(buildUnitlessQuantityEvidence(
      candidateFor("src/count.ts", source, "totalCount"),
      projectFiles,
    )).toBeUndefined();
  });
});
