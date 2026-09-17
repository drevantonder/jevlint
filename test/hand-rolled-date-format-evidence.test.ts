import { describe, expect, it } from "vitest";
import { extractCandidates } from "../src/candidates.js";
import { buildHandRolledDateFormatEvidence } from "../src/evidence/hand-rolled-date-format.js";
import { buildUnlocalizedUserStringEvidence } from "../src/evidence/unlocalized-user-string.js";
import type { ProjectFile } from "../src/types.js";

const SMELLY = `export function formatDateLabel(input: Date): string {
  const year = input.getFullYear();
  const month = String(input.getMonth() + 1).padStart(2, "0");
  const day = String(input.getDate()).padStart(2, "0");
  return year + "-" + month + "-" + day;
}
`;

const PINNED = `export function wireDate(input: Date): string {
  // Wire contract: YYYY-MM-DD, asserted by golden files.
  const year = input.getFullYear();
  const month = String(input.getMonth() + 1).padStart(2, "0");
  const day = String(input.getDate()).padStart(2, "0");
  return [year, month, day].join("-");
}
`;

const INTL_SHELF: ProjectFile = {
  filePath: "src/other.ts",
  source: "export const formatter = new Intl.DateTimeFormat(\"en-US\");\n",
};

const SINGLE_READ = `export function dayStart(input: Date): number {
  return input.getTime();
}
`;

function candidateFor(source: string, marker: string, extra: ProjectFile[] = []) {
  const filePath = "src/dates.ts";
  const projectFiles: ProjectFile[] = [{ filePath, source }, ...extra];
  const candidate = extractCandidates(filePath, source)
    .find(({ kind, source: text }) => kind === "function" && text.includes(marker));
  expect(candidate).toBeDefined();
  return { candidate: candidate!, projectFiles };
}

describe("hand-rolled date format evidence", () => {
  it("reports part reads with padStart and separator assembly", () => {
    const { candidate, projectFiles } = candidateFor(SMELLY, "formatDateLabel", [INTL_SHELF]);

    const evidence = buildHandRolledDateFormatEvidence(candidate, projectFiles);

    expect(evidence).toMatchObject({
      function: { name: "formatDateLabel" },
      dateParts: expect.arrayContaining([
        expect.objectContaining({ method: "getFullYear" }),
        expect.objectContaining({ method: "getMonth" }),
      ]),
      assembly: {
        padStartCalls: expect.arrayContaining([expect.stringContaining("padStart")]),
        separatorLiterals: expect.arrayContaining(["-"]),
      },
      usesIntlDateTimeFormat: false,
      intlDateShelf: ["src/other.ts"],
    });
  });

  it("carries the pinning justification side instead of abstaining", () => {
    const { candidate, projectFiles } = candidateFor(PINNED, "wireDate");

    const evidence = buildHandRolledDateFormatEvidence(candidate, projectFiles);

    expect(evidence?.pinnedOutputSignals.length).toBeGreaterThan(0);
  });

  it("abstains on a single timestamp read with no assembly", () => {
    const { candidate, projectFiles } = candidateFor(SINGLE_READ, "dayStart");

    expect(buildHandRolledDateFormatEvidence(candidate, projectFiles)).toBeUndefined();
  });

  it("stays silent where the user-string rule fires, and vice versa", () => {
    const strings: ProjectFile[] = [{
      filePath: "src/dates.ts",
      source: "export function banner(): string {\n"
        + "  return \"Order complete\";\n"
        + "}\n",
    }];
    const stringCandidate = extractCandidates("src/dates.ts", strings[0]!.source)
      .find(({ kind }) => kind === "function");
    expect(stringCandidate).toBeDefined();

    expect(buildHandRolledDateFormatEvidence(stringCandidate!, strings)).toBeUndefined();

    const { candidate, projectFiles } = candidateFor(SMELLY, "formatDateLabel");
    expect(buildUnlocalizedUserStringEvidence(candidate, projectFiles)).toBeUndefined();
  });
});
