import { readFile } from "node:fs/promises";
import { describe, expect, it } from "vitest";
import { extractCandidates } from "../src/candidates.js";
import { buildInappropriateIntimacyEvidence } from "../src/evidence/inappropriate-intimacy.js";
import type { ProjectFile } from "../src/types.js";

const root = new URL("./fixtures/repositories/inappropriate-intimacy-smelly/", import.meta.url);

async function load(filePath: string): Promise<ProjectFile> {
  return { filePath, source: await readFile(new URL(filePath, root), "utf8") };
}

describe("inappropriate intimacy evidence", () => {
  it("shows interior access past the advertised interface", async () => {
    const projectFiles = await Promise.all([
      "src/job-queue.ts",
      "src/drain.ts",
      "src/standalone.ts",
    ].map(load));
    const owner = projectFiles.find(({ filePath }) => filePath === "src/drain.ts");
    expect(owner).toBeDefined();
    if (!owner) return;
    const candidate = extractCandidates(owner.filePath, owner.source)
      .find(({ source }) => source.includes("function drainStale"));
    expect(candidate).toBeDefined();
    if (!candidate) return;

    const evidence = buildInappropriateIntimacyEvidence(candidate, projectFiles);

    expect(evidence).toMatchObject({
      function: {
        name: "drainStale",
        exported: true,
        source: expect.stringContaining("function drainStale"),
      },
      imports: expect.arrayContaining([
        expect.objectContaining({
          source: "./job-queue.js",
          ownership: "project-module",
          exportedMembers: expect.arrayContaining(["pendingCount", "enqueue", "queue"]),
        }),
      ]),
      foreignAccesses: expect.arrayContaining([
        expect.objectContaining({
          root: "queue",
          privateMarked: true,
          beyondAdvertised: true,
        }),
      ]),
    });
    expect(evidence?.foreignAccesses.length).toBeGreaterThan(0);
    expect(evidence?.foreignAccesses.every(({ root }) => root === "queue")).toBe(true);
  });

  it("shows advertised use without interior flags", async () => {
    const projectFiles = await Promise.all([
      "src/job-queue.ts",
      "src/drain.ts",
      "src/standalone.ts",
    ].map(load));
    const owner = projectFiles.find(({ filePath }) => filePath === "src/drain.ts");
    expect(owner).toBeDefined();
    if (!owner) return;
    const candidate = extractCandidates(owner.filePath, owner.source)
      .find(({ source }) => source.includes("function schedule"));
    expect(candidate).toBeDefined();
    if (!candidate) return;

    const evidence = buildInappropriateIntimacyEvidence(candidate, projectFiles);

    expect(evidence).toMatchObject({
      function: { name: "schedule" },
    });
    expect(evidence?.foreignAccesses.every(({ privateMarked }) => !privateMarked)).toBe(true);
    expect(evidence?.foreignAccesses.every(({ beyondAdvertised }) => !beyondAdvertised)).toBe(true);
  });

  it("abstains when the function touches no foreign module", async () => {
    const source = await readFile(new URL("src/standalone.ts", root), "utf8");
    const candidate = extractCandidates("src/standalone.ts", source)[0];
    expect(candidate).toBeDefined();
    if (!candidate) return;

    expect(buildInappropriateIntimacyEvidence(candidate, [{ filePath: "src/standalone.ts", source }]))
      .toBeUndefined();
  });
});
