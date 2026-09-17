import { describe, expect, it } from "vitest";
import { extractCandidates } from "../src/candidates.js";
import { buildHandRolledRelativeTimeEvidence } from "../src/evidence/hand-rolled-relative-time.js";
import type { ProjectFile } from "../src/types.js";

const SMELLY = `export function timeAgo(then: number): string {
  const diff = Date.now() - then;
  const minutes = Math.floor(diff / 60000);
  if (minutes < 1) return "just now";
  if (minutes < 60) return minutes + " minutes ago";
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return hours + " hours ago";
  const days = Math.floor(hours / 24);
  if (days < 7) return days + " days ago";
  const weeks = Math.floor(days / 7);
  return weeks + " weeks ago";
}
`;

const BRAND_COPY = `export function timeAgoBrand(then: number): string {
  const diff = Date.now() - then;
  const days = Math.floor(diff / 86400000);
  if (days < 1) return "today";
  if (days === 1) return "yesterday";
  const weeks = Math.floor(days / 7);
  return weeks + " weeks ago";
}
export function timeAgoBrandCaller(): string {
  return timeAgoBrand(Date.now() - 90000000);
}
`;

const SINGLE_UNIT = `export function minutesOld(then: number): number {
  return Math.floor((Date.now() - then) / 60000);
}
`;

function candidateFor(source: string, marker: string) {
  const filePath = "src/time.ts";
  const projectFiles: ProjectFile[] = [{ filePath, source }];
  const candidate = extractCandidates(filePath, source)
    .find(({ kind, source: text }) => kind === "function" && text.includes(marker));
  expect(candidate).toBeDefined();
  return { candidate: candidate!, projectFiles };
}

describe("hand-rolled relative time evidence", () => {
  it("reports a unit ladder with diff signals", () => {
    const { candidate, projectFiles } = candidateFor(SMELLY, "timeAgo");

    const evidence = buildHandRolledRelativeTimeEvidence(candidate, projectFiles);

    expect(evidence).toMatchObject({
      function: { name: "timeAgo" },
      units: expect.arrayContaining([
        expect.objectContaining({ unit: "minutes" }),
        expect.objectContaining({ unit: "days" }),
      ]),
      diffSignals: expect.arrayContaining(["60000"]),
      copyLiterals: expect.arrayContaining(["just now"]),
      usesIntlRelativeTimeFormat: false,
    });
  });

  it("carries pinned brand copy as justification-side signals", () => {
    const { candidate, projectFiles } = candidateFor(BRAND_COPY, "function timeAgoBrand(");

    const evidence = buildHandRolledRelativeTimeEvidence(candidate, projectFiles);

    expect(evidence?.copyLiterals).toEqual(expect.arrayContaining(["yesterday"]));
    expect(evidence?.pinnedCopySignals.length).toBeGreaterThan(0);
  });

  it("abstains on a single-unit numeric helper with no copy", () => {
    const { candidate, projectFiles } = candidateFor(SINGLE_UNIT, "minutesOld");

    expect(buildHandRolledRelativeTimeEvidence(candidate, projectFiles)).toBeUndefined();
  });
});
