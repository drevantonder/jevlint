import { readFile } from "node:fs/promises";
import { describe, expect, it } from "vitest";
import { extractCandidates } from "../src/candidates.js";
import { buildPreGateSideEffectEvidence } from "../src/evidence/pre-gate-side-effect.js";
import type { ProjectFile } from "../src/types.js";

async function project(name: string, paths: string[]): Promise<ProjectFile[]> {
  return Promise.all(paths.map(async (filePath) => ({
    filePath,
    source: await readFile(
      new URL(`./fixtures/repositories/${name}/${filePath}`, import.meta.url),
      "utf8",
    ),
  })));
}

function candidateFor(files: ProjectFile[], filePath: string, marker: string) {
  const file = files.find((entry) => entry.filePath === filePath);
  expect(file).toBeDefined();
  if (!file) return undefined;
  const candidate = extractCandidates(file.filePath, file.source)
    .find(({ source }) => source.includes(marker));
  expect(candidate).toBeDefined();
  return candidate;
}

describe("pre-gate side effect evidence", () => {
  it("shows Jev the cache write ordered before the limit rejection", async () => {
    const files = await project("pre-gate-side-effect-positive", [
      "src/device.ts",
      "src/cache.ts",
      "src/caller.ts",
    ]);
    const candidate = candidateFor(files, "src/device.ts", "registerDevice");
    if (!candidate) return;

    const evidence = buildPreGateSideEffectEvidence(candidate, files);

    expect(evidence).toMatchObject({
      function: {
        name: "registerDevice",
        exported: true,
        source: expect.stringContaining("deviceCache.set"),
      },
      effects: [
        {
          operation: expect.stringContaining("deviceCache.set"),
          target: "deviceCache",
          importedFrom: "./cache.js",
        },
      ],
      gates: [
        { condition: expect.stringContaining("accepted"), exitKind: "throw" },
      ],
      callers: [{ filePath: "src/caller.ts" }],
    });
  });

  it("abstains when every write follows the rejecting gate", async () => {
    const files = await project("pre-gate-side-effect-negative", [
      "src/device.ts",
      "src/cache.ts",
    ]);
    const candidate = candidateFor(files, "src/device.ts", "registerDevice");
    if (!candidate) return;

    expect(buildPreGateSideEffectEvidence(candidate, files)).toBeUndefined();
  });

  it("abstains for pure functions with no gates at all", () => {
    const source = `export function total(prices: number[]) {
      return prices.reduce((sum, price) => sum + price, 0);
    }`;
    const candidate = extractCandidates("src/total.ts", source)[0];
    expect(candidate).toBeDefined();
    if (!candidate) return;

    expect(buildPreGateSideEffectEvidence(candidate, [{ filePath: "src/total.ts", source }]))
      .toBeUndefined();
  });
});
