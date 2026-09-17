import { readFile } from "node:fs/promises";
import { describe, expect, it } from "vitest";
import { extractCandidates } from "../src/candidates.js";
import { buildConditionallyValidStateEvidence } from "../src/evidence/conditionally-valid-state.js";
import type { ProjectFile } from "../src/types.js";

const root = new URL("./fixtures/repositories/conditionally-valid-state-positive/", import.meta.url);

async function load(filePath: string): Promise<ProjectFile> {
  return { filePath, source: await readFile(new URL(filePath, root), "utf8") };
}

describe("conditionally valid state evidence", () => {
  it("connects a finite discriminant to optional payloads used by individual cases", async () => {
    const projectFiles = await Promise.all([
      "src/load-state.ts",
      "src/render-load-state.ts",
    ].map(load));
    const owner = projectFiles[0];
    expect(owner).toBeDefined();
    if (!owner) return;
    const candidate = extractCandidates(owner.filePath, owner.source)
      .find(({ kind, source }) => kind === "abstraction" && source.includes("LoadState"));
    expect(candidate).toBeDefined();
    if (!candidate) return;

    const evidence = buildConditionallyValidStateEvidence(candidate, projectFiles);

    expect(evidence).toMatchObject({
      stateType: { name: "LoadState", filePath: "src/load-state.ts" },
      discriminants: [{
        name: "status",
        cases: ["\"idle\"", "\"loading\"", "\"success\"", "\"error\""],
      }],
      looseProperties: [
        { name: "data", optional: true, nullable: false },
        { name: "errorMessage", optional: true, nullable: false },
      ],
      caseUses: expect.arrayContaining([
        expect.objectContaining({
          filePath: "src/render-load-state.ts",
          discriminant: "status",
          case: "\"success\"",
          propertiesReferenced: ["data"],
        }),
        expect.objectContaining({
          case: "\"error\"",
          propertiesReferenced: ["errorMessage"],
        }),
      ]),
    });
  });

  it("supports nullable payloads on object-shaped type aliases", () => {
    const source = `
      export type Result = {
        kind: "ok" | "failed";
        value: string | null;
        error: Error | null;
      };
      export function unwrap(result: Result): string {
        if (result.kind === "ok") return result.value!;
        if (result.kind === "failed") throw result.error!;
        return "";
      }
    `;
    const candidate = extractCandidates("src/result.ts", source)
      .find(({ kind }) => kind === "abstraction");
    expect(candidate).toBeDefined();
    if (!candidate) return;

    expect(buildConditionallyValidStateEvidence(
      candidate,
      [{ filePath: "src/result.ts", source }],
    )).toMatchObject({
      stateType: { name: "Result" },
      looseProperties: [
        { name: "value", nullable: true },
        { name: "error", nullable: true },
      ],
    });
  });

  it("abstains when optional fields are not coupled to discriminant cases", () => {
    const source = `
      export interface Notice { level: "info" | "warning"; note?: string }
      export function level(notice: Notice) { return notice.level; }
    `;
    const candidate = extractCandidates("src/notice.ts", source)[0];
    expect(candidate).toBeDefined();
    if (!candidate) return;

    expect(buildConditionallyValidStateEvidence(
      candidate,
      [{ filePath: "src/notice.ts", source }],
    )).toBeUndefined();
  });
});
