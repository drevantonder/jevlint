import { readFile } from "node:fs/promises";
import { describe, expect, it } from "vitest";
import { extractCandidates } from "../src/candidates.js";
import { buildLossySentinelReturnEvidence } from "../src/evidence/lossy-sentinel-return.js";
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

describe("lossy sentinel return evidence", () => {
  it("extracts sentinel paths, successful values, and callers", async () => {
    const files = await project("lossy-sentinel-return-positive", [
      "src/choose-delivery-slot.ts",
      "src/checkout.ts",
    ]);

    const evidence = buildLossySentinelReturnEvidence(changedFunction(files), files);

    expect(evidence).toMatchObject({
      function: { name: "chooseDeliverySlot" },
      sentinelReturns: [
        { value: "null", condition: "!order.address", branch: "then" },
        { value: "null", condition: "!serviceAreas.has(order.address.country)", branch: "then" },
        { value: "null", condition: "!slot", branch: "then" },
      ],
      valueReturns: [{ expression: "slot" }],
      callers: [expect.objectContaining({ call: "chooseDeliverySlot(order)" })],
    });
  });

  it("abstains when outcomes use an explicit result type", async () => {
    const files = await project("lossy-sentinel-return-negative", ["src/choose-delivery-slot.ts"]);

    expect(buildLossySentinelReturnEvidence(changedFunction(files), files)).toBeUndefined();
  });

  it.each([
    ["lossy-sentinel-return-exception", "src/find-active-session.ts", "null"],
    ["lossy-sentinel-return-ambiguous", "src/lookup-feature.ts", "undefined"],
  ])("retains semantic evidence for %s", async (name, filePath, sentinel) => {
    const files = await project(name, [filePath]);

    const evidence = buildLossySentinelReturnEvidence(changedFunction(files), files);

    expect(evidence?.sentinelReturns).toHaveLength(2);
    expect(evidence?.sentinelReturns.every(({ value }) => value === sentinel)).toBe(true);
  });

  it("ignores sentinel returns inside nested functions", () => {
    const source = `export function firstValue(values: string[]): string | null {
      values.forEach((value) => {
        if (!value) return null;
        if (value === "skip") return null;
      });
      return values[0] ?? null;
    }`;
    const candidate = extractCandidates("src/first-value.ts", source)[0];
    expect(candidate).toBeDefined();
    if (!candidate) return;

    expect(buildLossySentinelReturnEvidence(
      candidate,
      [{ filePath: "src/first-value.ts", source }],
    )).toBeUndefined();
  });
});
