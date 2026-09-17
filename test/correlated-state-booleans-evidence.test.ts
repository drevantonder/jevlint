import { readFile } from "node:fs/promises";
import { describe, expect, it } from "vitest";
import { extractCandidates } from "../src/candidates.js";
import { buildCorrelatedStateBooleansEvidence } from "../src/evidence/correlated-state-booleans.js";
import type { ProjectFile } from "../src/types.js";

const root = new URL("./fixtures/repositories/correlated-state-booleans-positive/", import.meta.url);

async function load(filePath: string): Promise<ProjectFile> {
  return { filePath, source: await readFile(new URL(filePath, root), "utf8") };
}

describe("correlated state booleans evidence", () => {
  it("connects boolean state fields to typed construction and transition code", async () => {
    const projectFiles = await Promise.all([
      "src/upload-state.ts",
      "src/upload-workflow.ts",
    ].map(load));
    const owner = projectFiles[0];
    expect(owner).toBeDefined();
    if (!owner) return;
    const candidate = extractCandidates(owner.filePath, owner.source)
      .find(({ kind }) => kind === "abstraction");
    expect(candidate).toBeDefined();
    if (!candidate) return;

    const evidence = buildCorrelatedStateBooleansEvidence(candidate, projectFiles);

    expect(evidence).toMatchObject({
      stateType: {
        name: "UploadState",
        filePath: "src/upload-state.ts",
        source: expect.stringContaining("isUploading: boolean"),
      },
      booleanProperties: [
        { name: "isQueued", optional: false },
        { name: "isUploading", optional: false },
        { name: "isComplete", optional: false },
        { name: "hasFailed", optional: false },
      ],
      usages: expect.arrayContaining([
        expect.objectContaining({
          filePath: "src/upload-workflow.ts",
          kind: "function",
          source: expect.stringContaining("startUpload"),
          propertiesReferenced: expect.arrayContaining(["isQueued", "isUploading"]),
        }),
      ]),
    });
  });

  it("supports object-shaped type aliases and imported aliases", () => {
    const ownerSource = "export type GateState = { isOpen: boolean; isLocked?: boolean };";
    const usageSource = `
      import type { GateState as State } from "./gate-state.js";
      export const locked: State = { isOpen: false, isLocked: true };
    `;
    const candidate = extractCandidates("src/gate-state.ts", ownerSource)[0];
    expect(candidate).toBeDefined();
    if (!candidate) return;

    expect(buildCorrelatedStateBooleansEvidence(candidate, [
      { filePath: "src/gate-state.ts", source: ownerSource },
      { filePath: "src/locked-gate.ts", source: usageSource },
    ])).toMatchObject({
      stateType: { name: "GateState" },
      booleanProperties: [{ name: "isOpen" }, { name: "isLocked", optional: true }],
      usages: [expect.objectContaining({ filePath: "src/locked-gate.ts", kind: "variable" })],
    });
  });

  it("abstains when a shape has only one boolean property", () => {
    const source = "export interface PanelState { isOpen: boolean; title: string }";
    const candidate = extractCandidates("src/panel.ts", source)[0];
    expect(candidate).toBeDefined();
    if (!candidate) return;

    expect(buildCorrelatedStateBooleansEvidence(
      candidate,
      [{ filePath: "src/panel.ts", source }],
    )).toBeUndefined();
  });
});
