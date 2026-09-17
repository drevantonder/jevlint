import { readFile } from "node:fs/promises";
import { describe, expect, it } from "vitest";
import { extractCandidates } from "../src/candidates.js";
import { buildMissingShutdownDrainEvidence } from "../src/evidence/missing-shutdown-drain.js";
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

describe("missing shutdown drain evidence", () => {
  it("shows Jev the bare listen next to the orchestrator descriptor", async () => {
    const files = await project("missing-shutdown-drain-positive", [
      "src/server.ts",
      "src/app.ts",
      "k8s/deployment.yaml",
    ]);
    const candidate = candidateFor(files, "src/server.ts", "startServer");
    if (!candidate) return;

    const evidence = buildMissingShutdownDrainEvidence(candidate, files);

    expect(evidence).toMatchObject({
      function: {
        name: "startServer",
        exported: true,
        source: expect.stringContaining("app.listen"),
      },
      bootstrapCalls: [expect.stringContaining("app.listen")],
      shutdown: {
        closeCalls: [],
        signalHandlers: [],
        drainWaits: [],
        connectionTracking: null,
        unreadyBeforeClose: false,
      },
      orchestratorManaged: {
        descriptor: "k8s/deployment.yaml",
        excerpt: expect.stringContaining("readinessProbe"),
      },
    });
  });

  it("reports the signal handler, drain wait, and connection tracking", async () => {
    const files = await project("missing-shutdown-drain-negative", [
      "src/server.ts",
      "src/app.ts",
    ]);
    const candidate = candidateFor(files, "src/server.ts", "startServer");
    if (!candidate) return;

    const evidence = buildMissingShutdownDrainEvidence(candidate, files);

    expect(evidence).toMatchObject({
      bootstrapCalls: [expect.stringContaining("app.listen")],
      shutdown: {
        closeCalls: [expect.stringContaining("server.close")],
        signalHandlers: [expect.stringContaining("SIGTERM")],
        connectionTracking: expect.stringContaining("openSockets"),
        unreadyBeforeClose: true,
      },
    });
  });

  it("abstains when the function never bootstraps a server", () => {
    const source = `export function runMigration(): string {
      return "done";
    }`;
    const candidate = extractCandidates("src/migrate.ts", source)
      .find(({ kind }) => kind === "function");
    expect(candidate).toBeDefined();
    if (!candidate) return;

    expect(buildMissingShutdownDrainEvidence(candidate, [{ filePath: "src/migrate.ts", source }]))
      .toBeUndefined();
  });
});
