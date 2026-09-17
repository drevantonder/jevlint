import { describe, expect, it } from "vitest";
import { extractCandidates } from "../src/candidates.js";
import { buildLaunderedAbsenceEvidence } from "../src/evidence/laundered-absence.js";

describe("laundered absence evidence", () => {
  it("extracts a nullish default over a boundary field that flows to return", async () => {
    const source = `
      export function listNames(data: { names: string[] }): string[] {
        const names = data.names ?? [];
        return names;
      }
    `;
    const candidate = extractCandidates("src/names.ts", source)[0];
    if (!candidate) return;

    expect(buildLaunderedAbsenceEvidence(
      candidate,
      [{ filePath: "src/names.ts", source }],
    )).toMatchObject({
      function: { name: "listNames", exported: true },
      defaults: [{
        kind: "nullish-default",
        defaulted: expect.stringContaining("data.names"),
        fallback: "[]",
        flowsToReturn: true,
      }],
    });
  });

  it("extracts a catch arm that discards the error into an empty success", async () => {
    const source = `
      export async function loadItems(path: string): Promise<string[]> {
        try {
          return await readItems(path);
        } catch {
          return [];
        }
      }
    `;
    const candidate = extractCandidates("src/items.ts", source)[0];
    if (!candidate) return;

    expect(buildLaunderedAbsenceEvidence(
      candidate,
      [{ filePath: "src/items.ts", source }],
    )).toMatchObject({
      catches: [{
        usesCaughtError: false,
        returned: "[]",
        returnsEmpty: true,
      }],
    });
  });

  it("abstains without defaults or catch returns", () => {
    const source = `
      export function total(values: number[]): number {
        return values.reduce((sum, value) => sum + value, 0);
      }
    `;
    const candidate = extractCandidates("src/total.ts", source)[0];
    if (!candidate) return;

    expect(buildLaunderedAbsenceEvidence(
      candidate,
      [{ filePath: "src/total.ts", source }],
    )).toBeUndefined();
  });
});
