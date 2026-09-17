import { readFile } from "node:fs/promises";
import { describe, expect, it } from "vitest";
import { extractCandidates } from "../src/candidates.js";
import { buildSilentQueueDropEvidence } from "../src/evidence/silent-queue-drop.js";
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

describe("silent queue drop evidence", () => {
  it("shows Jev the unchecked publish beside the queue client", async () => {
    const files = await project("silent-queue-drop-positive", [
      "src/publish.ts",
      "src/queue.ts",
      "src/route.ts",
    ]);
    const candidate = candidateFor(files, "src/publish.ts", "handleRequest");
    if (!candidate) return;

    const evidence = buildSilentQueueDropEvidence(candidate, files);

    expect(evidence).toMatchObject({
      function: {
        name: "handleRequest",
        exported: true,
        source: expect.stringContaining("queue.publish"),
      },
      producerCalls: [
        {
          method: "publish",
          receiver: "queue",
          importedFrom: "./queue.js",
          awaited: false,
          resultConsumed: false,
          guarded: false,
        },
      ],
      pressurePolicy: {
        drainListener: null,
        overflowPolicy: null,
      },
      queueClient: { source: "./queue.js", local: "queue" },
      repository: {
        callers: [{ filePath: "src/route.ts" }],
      },
    });
  });

  it("reports the overflow policy and consumed pressure signal", async () => {
    const files = await project("silent-queue-drop-negative", [
      "src/publish.ts",
      "src/queue.ts",
    ]);
    const candidate = candidateFor(files, "src/publish.ts", "handleRequest");
    if (!candidate) return;

    const evidence = buildSilentQueueDropEvidence(candidate, files);

    expect(evidence).toMatchObject({
      producerCalls: [
        { method: "publish", resultConsumed: true },
      ],
      pressurePolicy: {
        drainListener: expect.stringContaining("drain"),
        overflowPolicy: expect.stringContaining("highWaterMark"),
      },
    });
  });

  it("abstains when the function enqueues nothing", () => {
    const source = `export function handleRequest(body: string): string {
      return body.toUpperCase();
    }`;
    const candidate = extractCandidates("src/publish.ts", source)
      .find(({ kind }) => kind === "function");
    expect(candidate).toBeDefined();
    if (!candidate) return;

    expect(buildSilentQueueDropEvidence(candidate, [{ filePath: "src/publish.ts", source }]))
      .toBeUndefined();
  });
});
