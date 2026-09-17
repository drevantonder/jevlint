import { describe, expect, it } from "vitest";
import { extractCandidates } from "../src/candidates.js";
import { buildUnitScaleMismatchEvidence } from "../src/evidence/unit-scale-mismatch.js";

function candidateFor(source: string, marker: string) {
  const candidate = extractCandidates("src/retry.ts", source)
    .find(({ source: text }) => text.includes(marker));
  expect(candidate).toBeDefined();
  if (!candidate) throw new Error("fixture candidate missing");
  return candidate;
}

const SECONDS_TO_MS = `export function scheduleRetry(timeoutSec: number) {
  setTimeout(retry, timeoutSec * 1000);
}`;

const NAMED_CONVERSION = `export function scheduleRetry(timeoutSec: number) {
  setTimeout(retry, secToMs(timeoutSec));
}`;

const NO_SCALE = `export function greet(name: string) {
  return "hi " + name;
}`;

describe("unit scale mismatch evidence", () => {
  it("flags scale factors beside unit-suffixed names", () => {
    const candidate = candidateFor(SECONDS_TO_MS, "scheduleRetry");
    const projectFiles = [
      { filePath: "src/retry.ts", source: SECONDS_TO_MS },
      { filePath: "src/other.ts", source: "export function other() { setTimeout(retry, 5000); }" },
    ];
    const evidence = buildUnitScaleMismatchEvidence(candidate, projectFiles);
    expect(evidence).toMatchObject({
      function: { name: "scheduleRetry", exported: true },
      hasNamedConversion: false,
    });
    expect(evidence?.conversions.length).toBeGreaterThan(0);
    expect(evidence?.unitNames).toEqual(expect.arrayContaining(["timeoutSec"]));
  });

  it("records an explicit named conversion at the boundary", () => {
    const candidate = candidateFor(NAMED_CONVERSION, "scheduleRetry");
    const evidence = buildUnitScaleMismatchEvidence(candidate, [
      { filePath: "src/retry.ts", source: NAMED_CONVERSION },
    ]);
    expect(evidence?.hasNamedConversion).toBe(true);
  });

  it("abstains when no scale mixing exists", () => {
    const candidate = candidateFor(NO_SCALE, "greet");
    expect(buildUnitScaleMismatchEvidence(candidate, [
      { filePath: "src/retry.ts", source: NO_SCALE },
    ])).toBeUndefined();
  });
});
