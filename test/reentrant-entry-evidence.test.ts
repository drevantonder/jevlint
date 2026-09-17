import { readFile } from "node:fs/promises";
import { describe, expect, it } from "vitest";
import { extractCandidates } from "../src/candidates.js";
import { buildReentrantEntryEvidence } from "../src/evidence/reentrant-entry.js";
import { buildRuleEvidence } from "../src/evidence/index.js";
import type { ProjectFile } from "../src/types.js";

const root = new URL("./fixtures/repositories/reentrant-entry-smelly/", import.meta.url);

async function load(filePath: string): Promise<ProjectFile> {
  return { filePath, source: await readFile(new URL(filePath, root), "utf8") };
}

const guarded = `let pending: string[] = [];
let inProgress = false;
export function processQueue(): string[] {
  if (inProgress) return [];
  inProgress = true;
  try {
    const batch = pending;
    pending = [];
    return batch;
  } finally {
    inProgress = false;
  }
}
`;

const directOnly = `import { processQueue } from "./queue";
export function boot(): void {
  processQueue();
}
`;

describe("reentrant entry evidence", () => {
  it("partitions registration-shaped reachability from direct calls over mutated state", async () => {
    const projectFiles = await Promise.all(["src/queue.ts", "src/app.ts"].map(load));
    const owner = projectFiles[0];
    expect(owner).toBeDefined();
    if (!owner) return;
    const candidate = extractCandidates(owner.filePath, owner.source)
      .find(({ kind, source }) => kind === "function" && source.includes("pending = []"));
    expect(candidate).toBeDefined();
    if (!candidate) return;

    const evidence = buildReentrantEntryEvidence(candidate, projectFiles);

    expect(evidence).toMatchObject({
      function: { name: "processQueue", exported: true },
      mutatedBindings: ["pending"],
      guardPresent: false,
    });
    expect(evidence?.directCallers.map(({ filePath }) => filePath)).toContain("src/app.ts");
    expect(evidence?.registrationSites.map(({ filePath }) => filePath)).toContain("src/queue.ts");
  });

  it("still emits when a guard exists so Jev can weigh it", async () => {
    const projectFiles = await Promise.all(["src/queue.ts", "src/app.ts"].map(load));
    const guardedFiles: ProjectFile[] = [
      { filePath: "src/queue.ts", source: `${guarded}\nbus.on("drain", processQueue);\n` },
      ...(projectFiles.slice(1)),
    ];
    const candidate = extractCandidates("src/queue.ts", guardedFiles[0]!.source)
      .find(({ kind, source }) => kind === "function" && source.includes("inProgress"));
    expect(candidate).toBeDefined();
    if (!candidate) return;

    const evidence = buildReentrantEntryEvidence(candidate, guardedFiles);
    expect(evidence).toMatchObject({
      function: { name: "processQueue" },
      guardPresent: true,
    });
  });

  it("abstains when only direct reachability exists", () => {
    const queue = `let pending: string[] = [];
export function processQueue(): string[] {
  const batch = pending;
  pending = [];
  return batch;
}
`;
    const files = [
      { filePath: "src/queue.ts", source: queue },
      { filePath: "src/app.ts", source: directOnly },
    ];
    const candidate = extractCandidates("src/queue.ts", queue)
      .find(({ kind, source }) => kind === "function" && source.includes("pending = []"));
    expect(candidate).toBeDefined();
    if (!candidate) return;

    expect(buildReentrantEntryEvidence(candidate, files)).toBeUndefined();
  });

  it("dispatches through the rule registry", async () => {
    const projectFiles = await Promise.all(["src/queue.ts", "src/app.ts"].map(load));
    const owner = projectFiles[0];
    expect(owner).toBeDefined();
    if (!owner) return;
    const candidate = extractCandidates(owner.filePath, owner.source)
      .find(({ kind, source }) => kind === "function" && source.includes("pending = []"));
    expect(candidate).toBeDefined();
    if (!candidate) return;

    const result = buildRuleEvidence("jev/no-reentrant-entry", candidate, projectFiles);

    expect(result.handled).toBe(true);
    expect(result.handled && result.evidence).toBeDefined();
  });
});
