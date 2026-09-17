import { describe, expect, it } from "vitest";
import { extractCandidates } from "../src/candidates.js";
import { buildNonNarrowingGuardEvidence } from "../src/evidence/non-narrowing-guard.js";

describe("non narrowing guard evidence", () => {
  it("flags a guard re-checking a value settled earlier without reassignment", () => {
    const source = `
      export function describe(id: string | undefined): string {
        if (!id) return "anonymous";
        const label = id.toUpperCase();
        if (!id) return "anonymous";
        return label;
      }
    `;
    const candidate = extractCandidates("src/describe.ts", source)[0];
    if (!candidate) return;

    expect(buildNonNarrowingGuardEvidence(
      candidate,
      [{ filePath: "src/describe.ts", source }],
    )).toMatchObject({
      function: { name: "describe", exported: true },
      guards: [{
        kind: "if",
        tested: "id",
        settledBy: [expect.objectContaining({ kind: "guard-return", settled: "id" })],
        reassignedBetween: false,
      }],
      nearbyEscapeHatch: false,
    });
  });

  it("flags an optional chain over a value an earlier guard established", () => {
    const source = `
      export function label(name: string | undefined): string {
        if (!name) throw new Error("missing name");
        return name?.toUpperCase() ?? "anonymous";
      }
    `;
    const candidate = extractCandidates("src/label.ts", source)[0];
    if (!candidate) return;

    expect(buildNonNarrowingGuardEvidence(
      candidate,
      [{ filePath: "src/label.ts", source }],
    )).toMatchObject({
      guards: [expect.objectContaining({ kind: "optional-chain", tested: "name" })],
    });
  });

  it("abstains when a single guard settles an open question", () => {
    const source = `
      export function greet(name: string | undefined): string {
        if (!name) return "hello, stranger";
        return "hello, " + name;
      }
    `;
    const candidate = extractCandidates("src/greet.ts", source)[0];
    if (!candidate) return;

    expect(buildNonNarrowingGuardEvidence(
      candidate,
      [{ filePath: "src/greet.ts", source }],
    )).toBeUndefined();
  });
});
