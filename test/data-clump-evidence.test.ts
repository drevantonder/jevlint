import { readFile } from "node:fs/promises";
import { describe, expect, it } from "vitest";
import { extractCandidates } from "../src/candidates.js";
import { buildDataClumpEvidence } from "../src/evidence/data-clump.js";
import type { ProjectFile } from "../src/types.js";

const repositories = new URL("./fixtures/repositories/", import.meta.url);

async function project(name: string, paths: string[]): Promise<ProjectFile[]> {
  return Promise.all(paths.map(async (filePath) => ({
    filePath,
    source: await readFile(new URL(`${name}/${filePath}`, repositories), "utf8"),
  })));
}

function candidate(owner: ProjectFile) {
  return extractCandidates(owner.filePath, owner.source)
    .find(({ kind }) => kind === "function");
}

describe("data clump evidence", () => {
  it("shows Jev a parameter group repeated across functions and calls", async () => {
    const files = await project("data-clump-smelly", [
      "src/shipping-quote.ts",
      "src/shipping-label.ts",
      "src/validate-address.ts",
      "src/checkout.ts",
    ]);
    const owner = files[0];
    expect(owner).toBeDefined();
    if (!owner) return;
    const fn = candidate(owner);
    expect(fn).toBeDefined();
    if (!fn) return;

    const evidence = buildDataClumpEvidence(fn, files);

    expect(evidence).toMatchObject({
      function: {
        name: "calculateShippingQuote",
        filePath: "src/shipping-quote.ts",
        parameters: expect.arrayContaining([
          expect.objectContaining({ name: "street", type: "string" }),
          expect.objectContaining({ name: "postalCode", type: "string" }),
        ]),
      },
      repeatedGroup: ["city", "country", "postalCode", "street"],
      occurrences: expect.arrayContaining([
        expect.objectContaining({ filePath: "src/shipping-label.ts", name: "formatShippingLabel" }),
        expect.objectContaining({ filePath: "src/validate-address.ts", name: "validateAddress" }),
      ]),
      callers: [expect.objectContaining({
        filePath: "src/checkout.ts",
        call: expect.stringContaining("calculateShippingQuote("),
      })],
    });
  });

  it.each([
    ["data-clump-scalars", ["src/clamp.ts", "src/normalize.ts", "src/in-range.ts"]],
    ["data-clump-framework", ["src/auth-middleware.ts", "src/trace-middleware.ts", "src/csrf-middleware.ts"]],
    ["data-clump-ambiguous", ["src/copy-resource.ts", "src/sync-resource.ts", "src/move-resource.ts"]],
  ])("collects repetition without deciding the semantics for %s", async (name, paths) => {
    const files = await project(name, paths);
    const owner = files[0];
    expect(owner).toBeDefined();
    if (!owner) return;
    const fn = candidate(owner);
    expect(fn).toBeDefined();
    if (!fn) return;

    expect(buildDataClumpEvidence(fn, files)).toMatchObject({
      repeatedGroup: expect.any(Array),
      occurrences: [
        expect.objectContaining({ filePath: paths[1] }),
        expect.objectContaining({ filePath: paths[2] }),
      ],
    });
  });

  it("abstains when fewer than two other functions carry the group", () => {
    const first = "export function first(alpha: string, beta: string, gamma: string) {}";
    const second = "export function second(alpha: string, beta: string, gamma: string) {}";
    const fn = extractCandidates("src/first.ts", first)
      .find(({ kind }) => kind === "function");
    expect(fn).toBeDefined();
    if (!fn) return;

    expect(buildDataClumpEvidence(fn, [
      { filePath: "src/first.ts", source: first },
      { filePath: "src/second.ts", source: second },
    ])).toBeUndefined();
  });
});
