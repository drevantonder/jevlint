import { readFile } from "node:fs/promises";
import { describe, expect, it } from "vitest";
import { extractCandidates } from "../src/candidates.js";
import { buildSiblingIdentifierSwapEvidence } from "../src/evidence/sibling-identifier-swap.js";
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

describe("sibling identifier swap evidence", () => {
  it("shows Jev the repeated grantType next to the unused rawTokenId", async () => {
    const files = await project("sibling-identifier-swap-positive", [
      "src/token.ts",
      "src/caller.ts",
    ]);
    const candidate = candidateFor(files, "src/token.ts", "validateGrant");
    if (!candidate) return;

    const evidence = buildSiblingIdentifierSwapEvidence(candidate, files);

    expect(evidence).toMatchObject({
      function: {
        name: "validateGrant",
        exported: true,
        source: expect.stringContaining("requireNonNull"),
      },
      scopeBindings: expect.arrayContaining([
        expect.objectContaining({ name: "grantType", uses: expect.any(Number) }),
        expect.objectContaining({ name: "rawTokenId", uses: 0 }),
      ]),
      findings: expect.arrayContaining([
        expect.objectContaining({
          kind: "duplicate-argument",
          usedIdentifier: "grantType",
          unusedSibling: "rawTokenId",
        }),
      ]),
      callers: [{ filePath: "src/caller.ts" }],
    });
  });

  it("abstains when every sibling identifier is referenced", async () => {
    const files = await project("sibling-identifier-swap-negative", ["src/token.ts"]);
    const candidate = candidateFor(files, "src/token.ts", "validateGrant");
    if (!candidate) return;

    expect(buildSiblingIdentifierSwapEvidence(candidate, files)).toBeUndefined();
  });

  it("flags a value compared against itself", () => {
    const source = `export function slotChanged(slotStartTime: number, slotEndTime: number): boolean {
      if (slotStartTime === slotStartTime) return true;
      return slotEndTime > slotStartTime;
    }`;
    const candidate = extractCandidates("src/slots.ts", source)
      .find(({ source: text }) => text.includes("slotChanged"));
    expect(candidate).toBeDefined();
    if (!candidate) return;

    const evidence = buildSiblingIdentifierSwapEvidence(
      candidate,
      [{ filePath: "src/slots.ts", source }],
    );

    expect(evidence?.findings).toEqual(expect.arrayContaining([
      expect.objectContaining({ kind: "self-comparison", usedIdentifier: "slotStartTime" }),
    ]));
  });
});
