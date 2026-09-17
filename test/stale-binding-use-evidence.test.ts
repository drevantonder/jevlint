import { readFile } from "node:fs/promises";
import { describe, expect, it } from "vitest";
import { extractCandidates } from "../src/candidates.js";
import { buildStaleBindingUseEvidence } from "../src/evidence/stale-binding-use.js";
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

describe("stale binding use evidence", () => {
  it("shows Jev the discarded derivation alongside the stale return", async () => {
    const files = await project("stale-binding-use-positive", [
      "src/monitor.ts",
      "src/caller.ts",
    ]);
    const candidate = candidateFor(files, "src/monitor.ts", "currentConfig");
    if (!candidate) return;

    const evidence = buildStaleBindingUseEvidence(candidate, files);

    expect(evidence).toMatchObject({
      function: {
        name: "currentConfig",
        exported: true,
        source: expect.stringContaining("return monitor.config"),
      },
      staleUses: [
        {
          kind: "return",
          expression: "monitor.config",
          staleBinding: expect.stringContaining("monitor"),
          discardedDerivation: "updated",
        },
      ],
      derivedBindings: [
        {
          name: "updated",
          derivedFrom: expect.arrayContaining(["monitor"]),
          usedLater: false,
        },
      ],
      callers: [{ filePath: "src/caller.ts" }],
    });
  });

  it("abstains when the derived binding reaches the return", async () => {
    const files = await project("stale-binding-use-negative", ["src/monitor.ts"]);
    const candidate = candidateFor(files, "src/monitor.ts", "currentConfig");
    if (!candidate) return;

    expect(buildStaleBindingUseEvidence(candidate, files)).toBeUndefined();
  });

  it("abstains for functions with no derived bindings", () => {
    const source = `export function double(count: number) {
      return count * 2;
    }`;
    const candidate = extractCandidates("src/double.ts", source)[0];
    expect(candidate).toBeDefined();
    if (!candidate) return;

    expect(buildStaleBindingUseEvidence(candidate, [{ filePath: "src/double.ts", source }]))
      .toBeUndefined();
  });
});
