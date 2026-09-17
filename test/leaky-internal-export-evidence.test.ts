import { describe, expect, it } from "vitest";
import { extractCandidates } from "../src/candidates.js";
import { buildLeakyInternalExportEvidence } from "../src/evidence/leaky-internal-export.js";
import type { ProjectFile } from "../src/types.js";

const barrel = `export interface PublicConfig {
  timeout: number;
}
export * from "./internal/engine.js";
export { createApp } from "./app.js";
`;

const engine = `/** @internal engine helper, not public API */
export function tuneEngine(config: unknown) {
  return config;
}
`;

const app = `export function createApp() {
  return {};
}
`;

const outsider = `import { tuneEngine } from "./index.js";
export function boot() {
  return tuneEngine({});
}
`;

const cleanBarrel = `export interface PublicConfig {
  timeout: number;
}
export { createApp } from "./app.js";
export { formatName } from "./utils.js";
`;

const utils = `/** Formats a display name. */
export function formatName(name: string) {
  return name.trim();
}
`;

function candidateFor(source: string, filePath: string, marker: string) {
  const candidate = extractCandidates(filePath, source)
    .find(({ kind, source: text }) => kind === "abstraction" && text.includes(marker));
  expect(candidate).toBeDefined();
  return candidate!;
}

describe("leaky internal export evidence", () => {
  it("captures an export-all of an internal module reached through the barrel", () => {
    const files: ProjectFile[] = [
      { filePath: "src/index.ts", source: barrel },
      { filePath: "src/internal/engine.ts", source: engine },
      { filePath: "src/app.ts", source: app },
      { filePath: "src/boot.ts", source: outsider },
    ];
    const evidence = buildLeakyInternalExportEvidence(
      candidateFor(barrel, "src/index.ts", "PublicConfig"),
      files,
    );

    expect(evidence).toMatchObject({
      abstraction: { name: "PublicConfig", exported: true },
    });
    expect(evidence?.barrel.reExports.map(({ target }) => target))
      .toContain("./internal/engine.js");
    expect(evidence?.barrel.reExports[0]?.internalMarkers.length).toBeGreaterThan(0);
    expect(evidence?.externalReach.map(({ filePath }) => filePath)).toContain("src/boot.ts");
    expect(evidence?.internalTargets.find(({ filePath }) => filePath === "src/internal/engine.ts"))
      .toMatchObject({ documentsInternal: true });
  });

  it("abstains when the barrel re-exports only documented public modules", () => {
    const files: ProjectFile[] = [
      { filePath: "src/index.ts", source: cleanBarrel },
      { filePath: "src/app.ts", source: app },
      { filePath: "src/utils.ts", source: utils },
    ];
    expect(buildLeakyInternalExportEvidence(
      candidateFor(cleanBarrel, "src/index.ts", "PublicConfig"),
      files,
    )).toBeUndefined();
  });
});
