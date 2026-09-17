import { readFile } from "node:fs/promises";
import { describe, expect, it } from "vitest";
import { extractCandidates } from "../src/candidates.js";
import { buildParallelEnumerationsEvidence } from "../src/evidence/parallel-enumerations.js";
import type { ProjectFile } from "../src/types.js";

const root = new URL("./fixtures/repositories/parallel-enumerations-positive/", import.meta.url);
const negativeRoot = new URL("./fixtures/repositories/parallel-enumerations-negative/", import.meta.url);

async function load(base: URL, filePath: string): Promise<ProjectFile> {
  return { filePath, source: await readFile(new URL(filePath, base), "utf8") };
}

describe("parallel enumerations evidence", () => {
  it("pairs corresponding literal sets and reports their symmetric difference", async () => {
    const projectFiles = await Promise.all([
      "src/status.ts",
      "src/status-labels.ts",
    ].map((filePath) => load(root, filePath)));
    const owner = projectFiles[0];
    expect(owner).toBeDefined();
    if (!owner) return;
    const candidate = extractCandidates(owner.filePath, owner.source)
      .find(({ kind }) => kind === "abstraction");
    expect(candidate).toBeDefined();
    if (!candidate) return;

    const evidence = buildParallelEnumerationsEvidence(candidate, projectFiles);

    expect(evidence).toMatchObject({
      owner: {
        name: "Status",
        filePath: "src/status.ts",
        literals: expect.arrayContaining(["queued", "running", "done", "failed", "archived"]),
      },
      sibling: {
        name: "StatusLabel",
        filePath: "src/status-labels.ts",
      },
      shared: expect.arrayContaining(["queued", "running", "done", "failed"]),
      onlyInOwner: ["archived"],
      onlyInSibling: [],
    });
  });

  it("abstains when no corresponding sibling set exists", async () => {
    const projectFiles = await Promise.all([
      "src/color.ts",
      "src/size.ts",
    ].map((filePath) => load(negativeRoot, filePath)));
    const owner = projectFiles[0];
    expect(owner).toBeDefined();
    if (!owner) return;
    const candidate = extractCandidates(owner.filePath, owner.source)
      .find(({ kind }) => kind === "abstraction");
    expect(candidate).toBeDefined();
    if (!candidate) return;

    expect(buildParallelEnumerationsEvidence(candidate, projectFiles)).toBeUndefined();
  });

  it("abstains when the sibling file derives from the owner via keyof", () => {
    const ownerSource = `export type Status = "queued" | "running" | "done";`;
    const siblingSource = `import type { Status } from "./status.js";
export interface StatusLabel { queued: string; running: string; done: string; }
export function everyLabel(status: Status, labels: Record<keyof Status, string>): string {
  return labels[status];
}`;
    const candidate = extractCandidates("src/status.ts", ownerSource)[0];
    expect(candidate).toBeDefined();
    if (!candidate) return;

    expect(buildParallelEnumerationsEvidence(candidate, [
      { filePath: "src/status.ts", source: ownerSource },
      { filePath: "src/status-labels.ts", source: siblingSource },
    ])).toBeUndefined();
  });
});
