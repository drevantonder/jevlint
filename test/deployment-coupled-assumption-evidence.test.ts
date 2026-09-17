import { readFile } from "node:fs/promises";
import { describe, expect, it } from "vitest";
import { extractCandidates } from "../src/candidates.js";
import { buildDeploymentCoupledAssumptionEvidence } from "../src/evidence/deployment-coupled-assumption.js";
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

describe("deployment coupled assumption evidence", () => {
  it("shows Jev the localhost URL with no config read", async () => {
    const files = await project("deployment-coupled-assumption-positive", [
      "src/client.ts",
      "src/caller.ts",
    ]);
    const candidate = candidateFor(files, "src/client.ts", "fetchOrders");
    if (!candidate) return;

    const evidence = buildDeploymentCoupledAssumptionEvidence(candidate, files);

    expect(evidence).toMatchObject({
      function: {
        name: "fetchOrders",
        exported: true,
        source: expect.stringContaining("localhost"),
      },
      assumptions: [
        { kind: "localhost-url", expression: expect.stringContaining("localhost:3000") },
      ],
      configuration: {
        configReads: [],
        configSources: [],
      },
      repository: {
        callers: [{ filePath: "src/caller.ts" }],
      },
    });
  });

  it("reports the config read guarding the local fallback", async () => {
    const files = await project("deployment-coupled-assumption-negative", [
      "src/client.ts",
    ]);
    const candidate = candidateFor(files, "src/client.ts", "fetchOrders");
    if (!candidate) return;

    const evidence = buildDeploymentCoupledAssumptionEvidence(candidate, files);

    expect(evidence?.configuration.configReads).toEqual(
      expect.arrayContaining([expect.stringContaining("process.env.API_BASE_URL")]),
    );
  });

  it("abstains when the function bakes in no environment", () => {
    const source = `export async function fetchOrders(baseUrl: string): Promise<unknown> {
      const response = await fetch(baseUrl + "/api/orders");
      return response.json();
    }`;
    const candidate = extractCandidates("src/client.ts", source)
      .find(({ kind }) => kind === "function");
    expect(candidate).toBeDefined();
    if (!candidate) return;

    expect(buildDeploymentCoupledAssumptionEvidence(candidate, [{ filePath: "src/client.ts", source }]))
      .toBeUndefined();
  });
});
