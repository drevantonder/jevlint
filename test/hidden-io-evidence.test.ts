import { readFile } from "node:fs/promises";
import { describe, expect, it } from "vitest";
import { extractCandidates } from "../src/candidates.js";
import { buildHiddenIoEvidence } from "../src/evidence/hidden-io.js";
import type { ProjectFile } from "../src/types.js";

const repositories = new URL("./fixtures/repositories/", import.meta.url);

async function project(name: string, paths: string[]): Promise<ProjectFile[]> {
  return Promise.all(paths.map(async (filePath) => ({
    filePath,
    source: await readFile(new URL(`${name}/${filePath}`, repositories), "utf8"),
  })));
}

function changedFunction(files: ProjectFile[]) {
  const owner = files[0];
  expect(owner).toBeDefined();
  if (!owner) throw new Error("Fixture has no changed file.");
  const candidate = extractCandidates(owner.filePath, owner.source)
    .find(({ kind }) => kind === "function");
  expect(candidate).toBeDefined();
  if (!candidate) throw new Error("Fixture has no function candidate.");
  return candidate;
}

describe("hidden I/O evidence", () => {
  it("traces an awaited project call to its concrete network boundary and callers", async () => {
    const files = await project("hidden-io-positive", [
      "src/calculate-shipping-quote.ts",
      "src/shipping-gateway.ts",
      "src/checkout.ts",
    ]);

    const evidence = buildHiddenIoEvidence(changedFunction(files), files);

    expect(evidence).toMatchObject({
      function: { name: "calculateShippingQuote", async: true },
      ioOperations: [
        {
          expression: "requestShippingRate(destination, items)",
          awaited: true,
          certainty: "confirmed",
          reason: "project target calls global fetch",
          importedFrom: "./shipping-gateway.js",
          targetModule: {
            filePath: "src/shipping-gateway.ts",
            source: expect.stringContaining("fetch(\"https://rates.example/quotes\""),
          },
        },
      ],
      callers: [expect.objectContaining({ call: "calculateShippingQuote(order.destination, order.items)" })],
    });
  });

  it("abstains when the calculation is local", async () => {
    const files = await project("hidden-io-negative", ["src/calculate-shipping-quote.ts"]);

    expect(buildHiddenIoEvidence(changedFunction(files), files)).toBeUndefined();
  });

  it("retains a disclosed network boundary for semantic judgment", async () => {
    const files = await project("hidden-io-exception", ["src/fetch-shipping-quote.ts"]);

    expect(buildHiddenIoEvidence(changedFunction(files), files)?.ioOperations)
      .toEqual([expect.objectContaining({ certainty: "confirmed", reason: "calls global fetch" })]);
  });

  it("marks an awaited external call as possible rather than inventing I/O", async () => {
    const files = await project("hidden-io-ambiguous", ["src/resolve-tax.ts"]);

    expect(buildHiddenIoEvidence(changedFunction(files), files)?.ioOperations).toEqual([
      expect.objectContaining({
        expression: "taxRules.evaluate(order)",
        certainty: "possible",
        reason: "awaited external package call",
      }),
    ]);
  });
});
