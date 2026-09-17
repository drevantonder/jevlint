import { readFile } from "node:fs/promises";
import { describe, expect, it } from "vitest";
import { extractCandidates } from "../src/candidates.js";
import { buildMissingHealthSignalEvidence } from "../src/evidence/missing-health-signal.js";
import type { Candidate, ProjectFile } from "../src/types.js";

async function project(name: string, paths: string[]): Promise<ProjectFile[]> {
  return Promise.all(paths.map(async (filePath) => ({
    filePath,
    source: await readFile(
      new URL(`./fixtures/repositories/${name}/${filePath}`, import.meta.url),
      "utf8",
    ),
  })));
}

function candidateFor(files: ProjectFile[], filePath: string, marker: string): Candidate | undefined {
  const file = files.find((entry) => entry.filePath === filePath);
  expect(file).toBeDefined();
  if (!file) return undefined;
  const candidate = extractCandidates(file.filePath, file.source)
    .find(({ kind, source }) => kind === "function" && source.includes(marker));
  expect(candidate).toBeDefined();
  return candidate;
}

describe("missing health signal evidence", () => {
  it("shows Jev the serving surface with no probe beside the expected probe path", async () => {
    const files = await project("missing-health-signal-positive", [
      "src/service.ts",
      "src/app.ts",
      "src/users.ts",
      "k8s/deployment.yaml",
    ]);
    const candidate = candidateFor(files, "src/service.ts", "startService");
    if (!candidate) return;

    const evidence = buildMissingHealthSignalEvidence(candidate, files);

    expect(evidence).toMatchObject({
      function: {
        name: "startService",
        exported: true,
        source: expect.stringContaining("app.listen"),
      },
      servingSurface: [
        { kind: "route", expression: expect.stringContaining("/users") },
        { kind: "listen", expression: expect.stringContaining("app.listen") },
      ],
      healthSignals: [],
      expectedProbe: {
        descriptor: "k8s/deployment.yaml",
        path: "/healthz",
      },
    });
  });

  it("reports the servable health endpoint", async () => {
    const files = await project("missing-health-signal-negative", [
      "src/service.ts",
      "src/app.ts",
      "src/users.ts",
    ]);
    const candidate = candidateFor(files, "src/service.ts", "startService");
    if (!candidate) return;

    const evidence = buildMissingHealthSignalEvidence(candidate, files);

    expect(evidence?.healthSignals).toEqual(
      expect.arrayContaining([expect.stringContaining("/healthz")]),
    );
  });

  it("abstains when the module serves no traffic", () => {
    const source = `export function formatUser(name: string): string {
      return name.trim();
    }`;
    const candidate = extractCandidates("src/users.ts", source)
      .find(({ kind }) => kind === "function");
    expect(candidate).toBeDefined();
    if (!candidate) return;

    expect(buildMissingHealthSignalEvidence(candidate, [{ filePath: "src/users.ts", source }]))
      .toBeUndefined();
  });
});
