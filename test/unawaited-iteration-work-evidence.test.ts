import { readFile } from "node:fs/promises";
import { describe, expect, it } from "vitest";
import { extractCandidates } from "../src/candidates.js";
import { buildUnawaitedIterationWorkEvidence } from "../src/evidence/unawaited-iteration-work.js";
import type { ProjectFile } from "../src/types.js";

const repositories = new URL("./fixtures/repositories/", import.meta.url);

async function project(name: string, paths: string[]): Promise<ProjectFile[]> {
  return Promise.all(paths.map(async (filePath) => ({
    filePath,
    source: await readFile(new URL(`${name}/${filePath}`, repositories), "utf8"),
  })));
}

describe("unawaited iteration work evidence", () => {
  it("extracts forEach-async sites, try/catch regions, and callers", async () => {
    const projectFiles = await project("unawaited-iteration-positive", [
      "src/cancel-booking.ts",
      "src/bookings.ts",
      "src/handler.ts",
    ]);
    const owner = projectFiles[0];
    expect(owner).toBeDefined();
    if (!owner) return;
    const candidate = extractCandidates(owner.filePath, owner.source)
      .find(({ source }) => source.includes("function cancelBooking"));
    expect(candidate).toBeDefined();
    if (!candidate) return;

    const evidence = buildUnawaitedIterationWorkEvidence(candidate, projectFiles);

    expect(evidence).toMatchObject({
      function: { name: "cancelBooking", exported: true },
      iterations: [{
        method: "forEach",
        callbackAsync: true,
        call: expect.stringContaining("refundBooking"),
        awaitedCall: false,
        settledSignals: [],
      }],
      tryCatchRegions: [expect.stringContaining("forEach")],
      repository: {
        callers: [expect.objectContaining({ filePath: "src/handler.ts" })],
      },
    });
  });

  it("records Promise.all settlement on a mapped collection", async () => {
    const projectFiles = await project("unawaited-iteration-negative", [
      "src/cancel-booking.ts",
      "src/bookings.ts",
      "src/handler.ts",
    ]);
    const owner = projectFiles[0];
    expect(owner).toBeDefined();
    if (!owner) return;
    const candidate = extractCandidates(owner.filePath, owner.source)
      .find(({ source }) => source.includes("function cancelBooking"));
    expect(candidate).toBeDefined();
    if (!candidate) return;

    expect(buildUnawaitedIterationWorkEvidence(candidate, projectFiles)).toMatchObject({
      iterations: [{
        method: "map",
        callbackAsync: true,
        settledSignals: [expect.stringContaining("Promise.all")],
      }],
    });
  });

  it("abstains when iteration callbacks are synchronous", () => {
    const source = `
      export function logAll(items: string[]) {
        items.forEach((item) => console.log(item));
      }
    `;
    const candidate = extractCandidates("src/log.ts", source)[0];
    expect(candidate).toBeDefined();
    if (!candidate) return;

    expect(buildUnawaitedIterationWorkEvidence(
      candidate,
      [{ filePath: "src/log.ts", source }],
    )).toBeUndefined();
  });

  it("abstains for sequential for...of awaits", () => {
    const source = `
      export async function cancelAll(bookings: Booking[]) {
        for (const booking of bookings) {
          await refundBooking(booking);
        }
      }
    `;
    const candidate = extractCandidates("src/cancel.ts", source)[0];
    expect(candidate).toBeDefined();
    if (!candidate) return;

    expect(buildUnawaitedIterationWorkEvidence(
      candidate,
      [{ filePath: "src/cancel.ts", source }],
    )).toBeUndefined();
  });
});
