import { readFile } from "node:fs/promises";
import { describe, expect, it } from "vitest";
import { extractCandidates } from "../src/candidates.js";
import { buildUnconstrainedStateStringEvidence } from "../src/evidence/unconstrained-state-string.js";
import type { ProjectFile } from "../src/types.js";

const root = new URL("./fixtures/repositories/unconstrained-state-string-positive/", import.meta.url);

async function load(filePath: string): Promise<ProjectFile> {
  return { filePath, source: await readFile(new URL(filePath, root), "utf8") };
}

describe("unconstrained state string evidence", () => {
  it("finds a raw string used as a finite state discriminator", async () => {
    const projectFiles = await Promise.all([
      "src/order-process.ts",
      "src/order-actions.ts",
    ].map(load));
    const owner = projectFiles[0];
    expect(owner).toBeDefined();
    if (!owner) return;
    const candidate = extractCandidates(owner.filePath, owner.source)
      .find(({ kind }) => kind === "abstraction");
    expect(candidate).toBeDefined();
    if (!candidate) return;

    const evidence = buildUnconstrainedStateStringEvidence(candidate, projectFiles);

    expect(evidence).toMatchObject({
      stateType: { name: "OrderProcess", filePath: "src/order-process.ts" },
      stringProperties: [{ name: "status", optional: false }],
      finiteStateUses: [{
        property: "status",
        literals: expect.arrayContaining(["\"pending\"", "\"paid\"", "\"shipped\""]),
        decisions: expect.arrayContaining([
          expect.objectContaining({
            filePath: "src/order-actions.ts",
            kind: "switch",
            source: expect.stringContaining("switch (order.status)"),
          }),
        ]),
      }],
    });
  });

  it("supports a string property on an object-shaped type alias", () => {
    const source = `
      export type Task = { phase: string; title: string };
      export function label(task: Task) {
        if (task.phase === "queued") return "Queued";
        if (task.phase === "running") return "Running";
        return "Other";
      }
    `;
    const candidate = extractCandidates("src/task.ts", source)
      .find(({ kind }) => kind === "abstraction");
    expect(candidate).toBeDefined();
    if (!candidate) return;

    expect(buildUnconstrainedStateStringEvidence(
      candidate,
      [{ filePath: "src/task.ts", source }],
    )).toMatchObject({
      stateType: { name: "Task" },
      finiteStateUses: [{ property: "phase", literals: ["\"queued\"", "\"running\""] }],
    });
  });

  it("abstains from unconstrained strings without a finite-state decision", () => {
    const source = `
      export interface Article { title: string; body: string }
      export function display(article: Article) { return article.title + article.body; }
    `;
    const candidate = extractCandidates("src/article.ts", source)[0];
    expect(candidate).toBeDefined();
    if (!candidate) return;

    expect(buildUnconstrainedStateStringEvidence(
      candidate,
      [{ filePath: "src/article.ts", source }],
    )).toBeUndefined();
  });
});
