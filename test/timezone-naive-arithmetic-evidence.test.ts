import { describe, expect, it } from "vitest";
import { extractCandidates } from "../src/candidates.js";
import { buildTimezoneNaiveArithmeticEvidence } from "../src/evidence/timezone-naive-arithmetic.js";

function candidateFor(source: string, marker: string) {
  const candidate = extractCandidates("src/schedule.ts", source)
    .find(({ source: text }) => text.includes(marker));
  expect(candidate).toBeDefined();
  if (!candidate) throw new Error("fixture candidate missing");
  return candidate;
}

const DAY_STEP = `export function nextReminder(date: Date): Date {
  return new Date(date.getTime() + 86400000);
}`;

const NAIVE_FIELDS = `export function addDaysNaive(date: Date, days: number): Date {
  const shifted = new Date(date);
  shifted.setDate(shifted.getDate() + days);
  return shifted;
}`;

const AMBIGUOUS = `export function parseMeeting(raw: string): Date {
  return new Date("2026-03-08 02:30");
}`;

const MONOTONIC = `export function elapsedMs(startedAt: number): number {
  return Date.now() - startedAt;
}`;

describe("timezone naive arithmetic evidence", () => {
  it("flags fixed day steps over wall time", () => {
    const candidate = candidateFor(DAY_STEP, "86400000");
    const evidence = buildTimezoneNaiveArithmeticEvidence(candidate, [
      { filePath: "src/schedule.ts", source: DAY_STEP },
    ]);
    expect(evidence).toMatchObject({
      function: { name: "nextReminder", exported: true },
      usesFixedDayStep: true,
      tzAware: { importedFrom: null, usesTemporal: false },
    });
  });

  it("flags naive local-field arithmetic", () => {
    const candidate = candidateFor(NAIVE_FIELDS, "setDate");
    const evidence = buildTimezoneNaiveArithmeticEvidence(candidate, [
      { filePath: "src/schedule.ts", source: NAIVE_FIELDS },
    ]);
    expect(evidence?.usesNaiveFieldArithmetic).toBe(true);
  });

  it("flags ambiguous date parsing without an offset", () => {
    const candidate = candidateFor(AMBIGUOUS, "2026-03-08");
    const evidence = buildTimezoneNaiveArithmeticEvidence(candidate, [
      { filePath: "src/schedule.ts", source: AMBIGUOUS },
    ]);
    expect(evidence?.usesAmbiguousParse).toBe(true);
  });

  it("abstains for monotonic durations and non-function candidates", () => {
    const candidate = candidateFor(MONOTONIC, "elapsedMs");
    expect(buildTimezoneNaiveArithmeticEvidence(candidate, [
      { filePath: "src/schedule.ts", source: MONOTONIC },
    ])).toBeUndefined();
    const comment = extractCandidates("src/schedule.ts", "// note\n" + MONOTONIC)
      .find(({ kind }) => kind === "comment");
    expect(comment).toBeDefined();
    if (!comment) return;
    expect(buildTimezoneNaiveArithmeticEvidence(comment, [
      { filePath: "src/schedule.ts", source: "// note\n" + MONOTONIC },
    ])).toBeUndefined();
  });
});
