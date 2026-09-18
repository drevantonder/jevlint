import { describe, expect, it } from "vitest";
import { extractCandidates } from "../src/candidates.js";
import { buildDevDependencyRuntimeLeakEvidence } from "../src/evidence/dev-dependency-runtime-leak.js";
import type { ProjectFile } from "../src/types.js";

const MANIFEST = `{
  "name": "shop",
  "dependencies": { "express": "^4.0.0" },
  "devDependencies": { "vitest": "^3.0.0", "typescript": "^5.0.0" }
}
`;

const SERVER = `import { describe } from "vitest";
export function start(): void {
  describe("server", () => {});
}
`;

const TYPE_ONLY = `import type { Test } from "vitest";
export function plan(test: Test): string {
  return test.name;
}
`;

const CLEAN = `import express from "express";
export function start(): string {
  return express();
}
`;

function project(ownerPath: string, ownerSource: string, extra: ProjectFile[] = []) {
  const projectFiles: ProjectFile[] = [
    { filePath: ownerPath, source: ownerSource },
    { filePath: "package.json", source: MANIFEST },
    ...extra,
  ];
  const candidate = extractCandidates(ownerPath, ownerSource)
    .filter(({ kind }) => kind === "function")
    .find(({ source }) => source.includes("start") || source.includes("plan"));
  expect(candidate).toBeDefined();
  if (!candidate) throw new Error("Fixture has no function candidate.");
  return { candidate, projectFiles };
}

describe("dev dependency runtime leak evidence", () => {
  it("captures a shipped file using a dev-listed package at runtime", () => {
    const { candidate, projectFiles } = project("src/server.ts", SERVER);

    const evidence = buildDevDependencyRuntimeLeakEvidence(candidate, projectFiles);

    expect(evidence?.manifest).toBe("package.json");
    expect(evidence?.leaks).toHaveLength(1);
    expect(evidence?.leaks[0]).toMatchObject({
      specifier: "vitest",
      package: "vitest",
      via: "dev-dependency",
      typeOnlyImport: false,
    });
    expect(evidence?.leaks[0]?.valueUses).toBeGreaterThan(0);
  });

  it("flags type-only imports for Jev to discount", () => {
    const { candidate, projectFiles } = project("src/server.ts", TYPE_ONLY);

    const evidence = buildDevDependencyRuntimeLeakEvidence(candidate, projectFiles);

    expect(evidence?.leaks[0]).toMatchObject({
      specifier: "vitest",
      via: "dev-dependency",
      typeOnlyImport: true,
    });
  });

  it("captures a shipped file reaching a test-marked module", () => {
    const owner = `import { seed } from "./fixtures/seed.test.js";
export function start(): string {
  return seed();
}
`;
    // Filename-marked: the seed module carries the .test. segment, the
    // directory gate it used to rely on (fixtures/) is gone.
    const { candidate, projectFiles } = project("src/server.ts", owner, [
      { filePath: "src/fixtures/seed.test.ts", source: "export function seed(): string {\n  return \"x\";\n}\n" },
    ]);

    const evidence = buildDevDependencyRuntimeLeakEvidence(candidate, projectFiles);

    expect(evidence?.leaks[0]).toMatchObject({
      specifier: "./fixtures/seed.test.js",
      via: "test-module",
      targetModule: "src/fixtures/seed.test.ts",
    });
  });

  it("abstains when the owner only uses runtime dependencies", () => {
    const { candidate, projectFiles } = project("src/server.ts", CLEAN);

    expect(buildDevDependencyRuntimeLeakEvidence(candidate, projectFiles)).toBeUndefined();
  });

  it("abstains for test file owners", () => {
    const { candidate, projectFiles } = project("src/server.test.ts", SERVER);

    expect(buildDevDependencyRuntimeLeakEvidence(candidate, projectFiles)).toBeUndefined();
  });
});
